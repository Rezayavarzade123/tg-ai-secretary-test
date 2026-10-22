import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The installer is the first thing a stranger runs, as root, on a machine that
// holds their messages. So these tests are mostly about what it refuses and
// what it leaves alone: a dry run that changes nothing, an existing install it
// must not overwrite, a directory that is not ours, and a settings file that
// must never end up inside the git checkout.
//
// One test does a real install and waits for the control panel to answer, which
// is the only way to know the thing it installed actually runs.

const root = process.cwd();
const install = path.join(root, 'install.sh');
const uninstall = path.join(root, 'uninstall.sh');
const read = (p) => fs.readFileSync(p, 'utf8');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-installer-'));

function sh(script, args, opts = {}) {
  const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: 120_000, ...opts });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// A throwaway git checkout of this working tree. The installer behaves
// differently for a clean checkout (it clones, so /update works) than for a dirty
// one (it copies files); both are tested, and neither may depend on whether the
// developer happens to have uncommitted changes.
function makeSource({ dirty = false } = {}) {
  const dir = tmp();
  const files = spawnSync('bash', ['-c',
    `tar -cf - --exclude=.git --exclude=node_modules --exclude='bot/state*' --exclude='bot/.env' . | tar -xf - -C '${dir}'`,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(files.status, 0, files.stderr);
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'https://example.invalid/tg-ai-secretary.git');
  git('add', '-A');
  git('commit', '-qm', 'installer test fixture');
  if (dirty) fs.appendFileSync(path.join(dir, 'README.md'), '\n<!-- edited -->\n');
  return dir;
}

function freePort() {
  // Ask the kernel for one, then let it go. A fixed port would collide when the
  // suite runs next to a real instance.
  const sock = execFileSync('node', ['-e', `
    const s = require('node:net').createServer();
    s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); });
  `], { encoding: 'utf8' });
  return Number(sock.trim());
}

// --- the files themselves -----------------------------------------------------

test('both scripts parse, and both are executable', () => {
  for (const file of [install, uninstall]) {
    assert.equal(sh(file, ['--help']).code, 0, `${path.basename(file)} --help should succeed`);
    assert.ok(fs.statSync(file).mode & 0o111, `${path.basename(file)} should be executable`);
  }
  // bash -n catches the class of typo that only shows up on line 300 at 1am.
  for (const file of [install, uninstall]) {
    const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.basename(file)} should parse: ${r.stderr}`);
  }
});

test('the help text documents the flags the tests (and people) rely on', () => {
  const { out } = sh(install, ['--help']);
  for (const flag of ['--dir', '--token', '--port', '--no-service', '--dry-run', '--yes', '--help']) {
    assert.ok(out.includes(flag), `--help should mention ${flag}`);
  }
  assert.match(out, /install\.sh|uninstall\.sh/);
});

test('an unknown flag stops before touching anything', () => {
  const dir = path.join(tmp(), 'nope');
  const { code, out } = sh(install, ['--token-typo', 'x', '--dir', dir]);
  assert.notEqual(code, 0);
  assert.match(out, /Unknown option/);
  assert.equal(fs.existsSync(dir), false, 'nothing should have been created');
});

test('the installer never pipes a download into a shell', () => {
  const text = read(install);
  // The one download it does is `git clone`. An installer that asks for root is
  // the last place to hand a pipe to a shell, so no command may do it.
  const piping = text.split('\n').filter((line) => /^\s*curl\b/.test(line) && line.includes('|'));
  assert.deepEqual(piping, [], 'curl is never in a pipeline');
  assert.ok(!/\|\s*(ba)?sh\b/.test(text), 'no `… | sh` command lines');
});

test('secrets are written outside the repository, and mode 0600', () => {
  const text = read(install);
  assert.match(text, /\/etc\/secretary-bot\.env/, 'root installs write the settings to /etc');
  assert.match(text, /chmod 600/);
  // The path must be one the runtime actually reads (bot/env.mjs).
  const env = read(path.join(root, 'bot', 'env.mjs'));
  assert.ok(env.includes("'/etc/secretary-bot.env'"), 'bot/env.mjs reads the file install.sh writes');
});

test('the service restarts, because that is what makes /update work', () => {
  const text = read(install);
  assert.match(text, /Restart=always/);
  assert.match(text, /ExecStart=.*--import \.\/bot\/register\.mjs bot\/runner\.mjs/);
  assert.match(text, /EnvironmentFile=\$ENV_FILE/);
});

test('systemd is detected by asking it, not by looking for a directory', () => {
  const text = read(install);
  // A container has /run/systemd/system and a systemctl that fails. Installing
  // a unit there produces a "service" that never starts.
  assert.match(text, /systemctl is-system-running/);
  assert.match(text, /DO_SERVICE=no/);
});

test('the service unit it writes is one systemd accepts', async () => {
  // systemd is faked (a container has systemctl without an init), a throwaway
  // HOME catches the --user unit, and a dummy server on the panel port stands in
  // for the bot so the installer's own health check passes instantly.
  const fakeBin = tmp();
  fs.writeFileSync(path.join(fakeBin, 'systemctl'),
    '#!/bin/sh\ncase "$*" in *is-system-running*) echo running ;; esac\nexit 0\n', { mode: 0o755 });
  const home = tmp();
  const dir = path.join(tmp(), 'unit');
  const port = freePort();

  // Out of process on purpose: spawnSync blocks this event loop, so a server in
  // this test could never answer the installer's health check.
  const dummy = spawn('node', ['-e',
    `require('node:http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1');`,
  ], { stdio: 'ignore' });

  let result;
  try {
    // Give the dummy a moment to bind before the installer asks.
    for (let i = 0; i < 50; i += 1) {
      const probe = spawnSync('bash', ['-c', `exec 3<>/dev/tcp/127.0.0.1/${port}`]);
      if (probe.status === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    result = sh(install, ['--yes', '--dir', dir, '--service', '--port', String(port), '--token', '1:a'], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HOME: home },
    });
  } finally {
    dummy.kill();
  }

  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /No root: the service is installed as a systemd --user unit/);

  const unitPath = path.join(home, '.config', 'systemd', 'user', 'secretary.service');
  assert.ok(fs.existsSync(unitPath), 'a --user unit should be written');
  const unit = read(unitPath);

  assert.match(unit, /^WorkingDirectory=.*unit$/m);
  assert.match(unit, /^EnvironmentFile=.*\.env$/m);
  assert.match(unit, /^ExecStart=\S*node --import \.\/bot\/register\.mjs bot\/runner\.mjs$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.match(unit, /Installed by install\.sh/, 'uninstall.sh identifies its own files by this line');

  // Real syntax check when the tool is available.
  const verify = spawnSync('systemd-analyze', ['verify', unitPath], { encoding: 'utf8' });
  if (!verify.error) assert.equal(verify.status, 0, verify.stderr || verify.stdout);
});

// --- what it refuses ----------------------------------------------------------

test('a directory that is not ours is refused unless --force', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'something-else.txt'), 'mine');

  const refused = sh(install, ['--yes', '--dir', dir, '--no-service', '--port', '8701']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /not empty and does not look like this project/);
  assert.equal(fs.existsSync(path.join(dir, 'bot')), false, 'nothing should have been installed');

  const forced = sh(install, ['--yes', '--dir', dir, '--no-service', '--port', '8701', '--force']);
  assert.equal(forced.code, 0, forced.out);
  assert.ok(fs.existsSync(path.join(dir, 'bot', 'runner.mjs')));
  assert.ok(fs.existsSync(path.join(dir, 'something-else.txt')), 'existing files are left alone');
});

test('--dry-run changes nothing on disk', () => {
  const dir = path.join(tmp(), 'dry');
  const { code, out } = sh(install, ['--dry-run', '--dir', dir, '--no-service', '--port', '8702', '--token', '1:x']);

  assert.equal(code, 0, out);
  assert.match(out, /Checking this machine/);
  assert.match(out, /Getting the code/);
  assert.match(out, /dry run: nothing above was actually done/);
  assert.equal(fs.existsSync(dir), false, 'a dry run must not create the install directory');
});

// --- a real install -----------------------------------------------------------

test('a real install lands the code, a private settings file and a running panel', () => {
  const dir = path.join(tmp(), 'app');
  const port = freePort();
  const source = makeSource();
  // Random per run: the test file itself must not be a place the token can be
  // found, or the leak check below would pass for the wrong reason.
  const token = `123456789:AA${Math.random().toString(36).slice(2, 14)}`;
  const { code, out } = sh(path.join(source, 'install.sh'), [
    '--yes', '--dir', dir, '--no-service', '--port', String(port),
    '--token', token, '--timezone', 'Europe/London',
  ]);

  assert.equal(code, 0, out);
  assert.match(out, /It runs: the control panel answers/, out);

  // The code is there and it is the project.
  for (const file of ['package.json', 'bot/runner.mjs', 'bot/panel/server.mjs', 'bot/updater.mjs']) {
    assert.ok(fs.existsSync(path.join(dir, file)), `${file} should be installed`);
  }

  // Installed from a clean checkout, so it is a git checkout too — with `origin`
  // re-pointed at the real remote, which is what makes /update work in the
  // installed copy instead of pulling from the directory it came from.
  assert.ok(fs.existsSync(path.join(dir, '.git')), 'a clean checkout is installed as a clone');
  const origin = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  assert.equal(origin.stdout.trim(), 'https://example.invalid/tg-ai-secretary.git',
    'origin is the real remote, not the local directory it was cloned from');

  // No local state or demo data travels with it.
  assert.equal(fs.existsSync(path.join(dir, 'bot', 'state-demo')), false);
  assert.ok(fs.existsSync(path.join(dir, 'bot', 'state')), 'the state directory is created');

  // The settings file: correct values, not readable by others.
  const envFile = path.join(dir, 'bot', '.env');
  assert.ok(fs.existsSync(envFile));
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  const env = read(envFile);
  assert.match(env, new RegExp(`^BOT_TOKEN=${token}$`, 'm'));
  assert.match(env, new RegExp(`^PANEL_PORT=${port}$`, 'm'));
  assert.match(env, /^BOT_TIMEZONE=Europe\/London$/m);
  assert.equal(fs.statSync(path.join(dir, 'bot', 'state')).mode & 0o777, 0o700);

  // The token lives in the settings file, and in the state file the runtime
  // copies it into (inside the 0700 state directory) — nowhere else.
  const leaked = spawnSync('grep', ['-rl', token, '--exclude=.env', '--exclude=bot.json', '.'], { cwd: dir, encoding: 'utf8' });
  assert.equal((leaked.stdout ?? '').trim(), '', `the token leaked into: ${leaked.stdout}`);
  assert.equal(fs.statSync(path.join(dir, 'bot', 'state')).mode & 0o777, 0o700,
    'the directory that holds the token is private');

  // The token the installer prints is the one the panel actually accepts.
  const printed = /panel token ([0-9a-f]{16,})/.exec(out)?.[1];
  if (printed) {
    assert.equal(read(path.join(dir, 'bot', 'state', 'panel-token')).trim(), printed);
  }
});

test('a dirty checkout is copied as files, and says /update will not work', () => {
  const dir = path.join(tmp(), 'dirty');
  const port = freePort();
  const source = makeSource({ dirty: true });
  const { code, out } = sh(path.join(source, 'install.sh'), [
    '--yes', '--dir', dir, '--no-service', '--port', String(port), '--token', '1:a',
  ]);

  assert.equal(code, 0, out);
  assert.match(out, /copied as files/);
  assert.match(out, /\/update will not work here/);
  assert.equal(fs.existsSync(path.join(dir, '.git')), false, 'no history to update from');
  assert.ok(fs.existsSync(path.join(dir, 'bot', 'runner.mjs')));
});

test('a second run is an upgrade: settings and messages survive', () => {
  const dir = path.join(tmp(), 'upgrade');
  const port = freePort();
  const source = makeSource();
  const script = path.join(source, 'install.sh');
  const args = ['--yes', '--dir', dir, '--no-service', '--port', String(port), '--token', '123:first'];

  assert.equal(sh(script, args).code, 0);
  const envBefore = read(path.join(dir, 'bot', '.env'));
  const stateBefore = read(path.join(dir, 'bot', 'state', 'bot.json'));

  const second = sh(script, ['--yes', '--dir', dir, '--no-service', '--port', String(port)]);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /upgrading/i);
  assert.match(second.out, /Keeping the existing settings/);

  assert.equal(read(path.join(dir, 'bot', '.env')), envBefore, 'settings are not rewritten');
  assert.equal(read(path.join(dir, 'bot', 'state', 'bot.json')), stateBefore, 'messages are not touched');
  // And it still has exactly one of everything.
  assert.equal(fs.existsSync(path.join(dir, 'bot', 'runner.mjs')), true);
});

// --- uninstall ----------------------------------------------------------------

test('uninstall keeps the data unless --purge, and only removes units it wrote', () => {
  const dir = path.join(tmp(), 'bye');
  const source = makeSource();
  assert.equal(sh(path.join(source, 'install.sh'), ['--yes', '--dir', dir, '--no-service', '--port', String(freePort()), '--token', '1:a']).code, 0);

  const kept = sh(uninstall, ['--dir', dir, '--yes']);
  assert.equal(kept.code, 0, kept.out);
  assert.match(kept.out, /your data is still there/i);
  assert.ok(fs.existsSync(path.join(dir, 'bot', 'state')));

  const purged = sh(uninstall, ['--dir', dir, '--purge', '--yes']);
  assert.equal(purged.code, 0, purged.out);
  assert.equal(fs.existsSync(dir), false, '--purge removes the directory');
});

test('uninstall without --purge does not need a prompt', () => {
  const dir = path.join(tmp(), 'quiet');
  const source = makeSource();
  assert.equal(sh(path.join(source, 'install.sh'), ['--yes', '--dir', dir, '--no-service', '--port', String(freePort()), '--token', '1:a']).code, 0);
  const { code } = sh(uninstall, ['--dir', dir, '--yes'], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(code, 0);
  assert.ok(fs.existsSync(dir));
});
