import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// tg-secretary is the command a person types after installing. It has to work from
// a symlink on PATH, find the right install when there are two, and be honest when
// there is nothing there — so these tests build fake installs rather than touching
// the real one, and drive the real script.

const root = process.cwd();
const cli = path.join(root, 'bin', 'tg-secretary');
const install = path.join(root, 'install.sh');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tg-secretary-cli-'));

// A directory that looks like an install to the command: package.json, the entry
// point, a settings file and a panel token.
function fakeInstall({ version = '9.9.9', port = '8999', token = 'abc123def456', withToken = true } = {}) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'bot', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tg-ai-secretary', version }));
  fs.writeFileSync(path.join(dir, 'bot', 'runner.mjs'), '// stub\n');
  fs.writeFileSync(path.join(dir, 'bot', '.env'), `PANEL_PORT=${port}\nPANEL_HOST=127.0.0.1\nPANEL_TOKEN=\nLLM_BASE_URL=http://127.0.0.1:8080\n`);
  if (withToken) fs.writeFileSync(path.join(dir, 'bot', 'state', 'panel-token'), `${token}\n`);
  return { dir, token, port };
}

function run(args, opts = {}) {
  const r = spawnSync('bash', [cli, ...args], { encoding: 'utf8', timeout: 60_000, ...opts });
  return { code: r.status, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}`, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// --- the command itself -------------------------------------------------------

test('the script parses and is executable', () => {
  const syntax = spawnSync('bash', ['-n', cli], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.ok(fs.statSync(cli).mode & 0o111, 'bin/tg-secretary should be executable');
});

test('help lists the commands a person actually needs', () => {
  const { code, out } = run(['--help']);
  assert.equal(code, 0);
  for (const word of ['status', 'panel', 'start', 'stop', 'restart', 'logs', 'update', 'uninstall']) {
    assert.ok(out.includes(word), `help should mention ${word}`);
  }
  assert.match(out, /--dir PATH/);
});

test('an unknown command is a usage error, not a stack trace', () => {
  const { code, all } = run(['frobnicate']);
  assert.equal(code, 2);
  assert.match(all, /Unknown command: frobnicate/);
  assert.match(all, /tg-secretary/, 'and it repeats the usage');
});

test('a missing install is explained, with the two ways to fix it', () => {
  const { code, all } = run(['--dir', path.join(tmp(), 'nope'), 'status']);
  assert.equal(code, 1);
  assert.match(all, /I cannot find the installation|No installation at/);
  assert.match(all, /--dir|SECRETARY_HOME/);
});

// --- reading an install -------------------------------------------------------

test('version and paths come from the install, not from this checkout', () => {
  const { dir } = fakeInstall({ version: '7.7.7' });
  assert.equal(run(['--dir', dir, 'version']).out.trim(), 'tg-secretary 7.7.7');

  const paths = run(['--dir', dir, 'paths']).out;
  assert.match(paths, new RegExp(`install\\s+${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(paths, /settings\s+.*bot\/\.env/);
  assert.match(paths, /state\s+.*bot\/state/);
});

test('SECRETARY_HOME works for a shell session', () => {
  const { dir } = fakeInstall({ version: '8.8.8' });
  const env = { ...process.env, SECRETARY_HOME: dir };
  assert.equal(run(['version'], { env }).out.trim(), 'tg-secretary 8.8.8');
});

test('panel prints a URL you can paste, with the token that is on disk', () => {
  const { dir, token, port } = fakeInstall();
  const { code, out } = run(['--dir', dir, 'panel']);
  assert.equal(code, 0);
  assert.equal(out.trim().split('\n')[0], `http://127.0.0.1:${port}/?token=${token}`);
  assert.equal(run(['--dir', dir, 'token']).out.trim(), token);
});

test('no token yet is an instruction, not an empty line', () => {
  const { dir } = fakeInstall({ withToken: false });
  const { code, all } = run(['--dir', dir, 'token']);
  assert.equal(code, 1);
  assert.match(all, /No panel token yet/);
  assert.match(all, /start/, 'it says how to get one');
});

test('status reports the install, the service and the model server', () => {
  const { dir, port, token } = fakeInstall();
  const { code, out } = run(['--dir', dir, 'status']);

  assert.equal(code, 0);
  assert.match(out, /tg-secretary 9\.9\.9/);
  assert.match(out, new RegExp(`data\\s+${dir}`));
  assert.match(out, new RegExp(`panel\\s+.*127\\.0\\.0\\.1:${port}`));
  assert.ok(out.includes(token), 'the token is in status, so one command answers everything');
  // Nothing is running in a test, so it must say so rather than imply health.
  assert.match(out, /not running/);
  assert.match(out, /model\s+.*not answering/);
});

// --- installed on PATH --------------------------------------------------------

test('installing puts tg-secretary on PATH, pointing into the install', () => {
  const home = tmp();
  const dir = path.join(tmp(), 'app');
  // A clean checkout, so the installer clones and the command in the install runs.
  const source = tmp();
  const copy = spawnSync('bash', ['-c',
    `tar -cf - --exclude=.git --exclude=node_modules --exclude='bot/state*' --exclude='bot/.env' . | tar -xf - -C '${source}'`,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(copy.status, 0, copy.stderr);
  const git = (...args) => spawnSync('git', ['-C', source, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'fixture');

  const port = String(8900 + Math.floor(Math.random() * 60));
  const r = spawnSync('bash', [path.join(source, 'install.sh'), '--yes', '--dir', dir, '--no-service',
    '--port', port, '--token', '1:a'], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, HOME: home },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);

  const link = path.join(home, '.local', 'bin', 'tg-secretary');
  assert.ok(fs.existsSync(link), 'the command should be linked into ~/.local/bin');
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(dir, 'bin', 'tg-secretary')));

  // And it runs from there, finding its own install through the symlink.
  const invoked = spawnSync('bash', [link, 'version'], { encoding: 'utf8' });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.match(invoked.stdout, /tg-secretary \d+\.\d+\.\d+/);

  const status = spawnSync('bash', [link, 'status'], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.includes(dir), 'status names the install it found through the link');

  // Uninstalling (keeping data) must not leave a command pointing at nothing.
  spawnSync('bash', [path.join(source, 'uninstall.sh'), '--dir', dir, '--yes'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(fs.existsSync(link), false, 'the link goes with the install');
  assert.ok(fs.existsSync(dir), 'the data is still there');
});

test('a link that belongs to another install is left alone', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const foreign = path.join(tmp(), 'other-tool');
  fs.writeFileSync(foreign, '#!/bin/sh\necho not ours\n');
  fs.chmodSync(foreign, 0o755);
  fs.symlinkSync(foreign, path.join(home, '.local', 'bin', 'tg-secretary'));

  const dir = fakeInstall().dir;
  const r = spawnSync('bash', [path.join(root, 'uninstall.sh'), '--dir', dir, '--yes'], {
    encoding: 'utf8', env: { ...process.env, HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(home, '.local', 'bin', 'tg-secretary')), 'not our link, not our business');
});

test('--no-link installs without touching PATH', () => {
  const home = tmp();
  const dir = path.join(tmp(), 'app');
  const r = spawnSync('bash', [install, '--yes', '--dir', dir, '--no-service', '--no-link',
    '--port', String(8960 + Math.floor(Math.random() * 30)), '--token', '1:a'], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, HOME: home },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /Skipped \(--no-link\)/);
  assert.equal(fs.existsSync(path.join(home, '.local', 'bin', 'tg-secretary')), false);
});
