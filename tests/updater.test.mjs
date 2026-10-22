import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseCount, parseLog, decide, describeStatus, createUpdater, readVersion } from '../bot/updater.mjs';

// The updater is a remote-code-execution path by construction, so the tests are
// about what it refuses as much as what it does. Half of them use a fake `run`;
// the other half build two real temporary repositories and update one from the
// other, which is the only way to prove the fast-forward rule actually holds.

// --- parsing and policy -------------------------------------------------------

test('counts are read from git, and nonsense becomes zero', () => {
  assert.equal(parseCount('3\n'), 3);
  assert.equal(parseCount('0'), 0);
  assert.equal(parseCount(''), 0);
  assert.equal(parseCount('fatal: bad revision'), 0);
  assert.equal(parseCount('-2'), 0);
});

test('the log parser survives awkward subjects', () => {
  const out = [
    'a1b2c3d\x1fFix: the | thing — with ünicode\x1fSam\x1f2 hours ago',
    'd4e5f6a\x1fsecond\x1fAna\x1f3 days ago',
    '',
  ].join('\n');
  const commits = parseLog(out);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].sha, 'a1b2c3d');
  assert.match(commits[0].subject, /the \| thing/);
  assert.equal(commits[1].author, 'Ana');
});

test('the policy installs only on an explicit setting, a clean tree and a fast-forward', () => {
  const clean = { gitAvailable: true, isRepo: true, dirty: false, behind: 2, diverged: false, inProgress: false };

  assert.equal(decide('apply', clean).action, 'apply');
  assert.equal(decide('notify', clean).action, 'notify', 'notify never installs');
  assert.equal(decide('off', { ...clean, behind: 9 }).action, 'none');

  // Every one of these must block, whatever the mode.
  for (const broken of [
    { ...clean, dirty: true },
    { ...clean, diverged: true },
    { ...clean, inProgress: true },
  ]) {
    assert.equal(decide('apply', broken).action, 'blocked', JSON.stringify(broken));
  }

  assert.equal(decide('apply', { ...clean, behind: 0 }).action, 'none', 'up to date means do nothing');
  assert.equal(decide('apply', { ...clean, gitAvailable: false }).action, 'none');
  assert.equal(decide('apply', { ...clean, isRepo: false }).action, 'none');
  assert.equal(decide('apply', { ...clean, paused: true }).action, 'none', 'paused wins over everything');
});

test('the status line never claims more than it measured', () => {
  assert.match(describeStatus({ gitAvailable: false }), /git is not installed/);
  assert.match(describeStatus({ isRepo: false, gitAvailable: true }), /not installed with git/);
  assert.match(describeStatus({ isRepo: true, gitAvailable: true, branch: 'main', head: 'abcdef1234', behind: 0 }), /up to date \(main at abcdef1\)/);
  assert.match(describeStatus({ isRepo: true, gitAvailable: true, behind: 3, branch: 'main' }), /3 new commit/);
  assert.match(describeStatus({ isRepo: true, gitAvailable: true, dirty: true }), /local changes/);
  assert.match(describeStatus({ isRepo: true, gitAvailable: true, error: 'network down' }), /could not check: network down/);
});

// --- against a fake git -------------------------------------------------------

function fakeGit(responses) {
  const calls = [];
  const run = async (args) => {
    const key = args.slice(1).join(' ');
    calls.push(key);
    const hit = Object.keys(responses).find((k) => key.startsWith(k));
    const value = hit ? responses[hit] : '';
    if (typeof value === 'function') return value(args);
    // A response may be a bare stdout string or a full { code, stdout, stderr }.
    if (value && typeof value === 'object') return value;
    return { code: 0, stdout: value, stderr: '' };
  };
  return { run, calls };
}

test('a checkout that is not a repository says so instead of guessing', async () => {
  const { run } = fakeGit({
    '--version': { code: 0, stdout: 'git version 2.43.0' },
    'rev-parse --show-toplevel': { code: 128, stdout: '', stderr: 'not a git repository' },
  });
  const u = createUpdater({ cwd: '/tmp', run });
  const s = await u.status();
  assert.equal(s.isRepo, false);
  assert.equal(s.gitAvailable, true);
  await assert.rejects(() => u.apply(), /not installed with git/);
});

test('behind/ahead are read from rev-list, and a local commit blocks the update', async () => {
  const { run } = fakeGit({
    '--version': { code: 0, stdout: 'git version 2.43.0' },
    'rev-parse --show-toplevel': { code: 0, stdout: '/srv/bot' },
    'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'main' },
    'rev-parse HEAD': { code: 0, stdout: 'deadbeefdeadbeef' },
    'status --porcelain': { code: 0, stdout: '' },
    'remote get-url': { code: 0, stdout: 'git@github.com:me/bot.git' },
    'rev-list --left-right': { code: 0, stdout: '1\t2' },
    'log --pretty': { code: 0, stdout: 'abc1234\x1fFix the thing\x1fSam\x1f1 hour ago' },
  });
  const u = createUpdater({ cwd: '/srv/bot', run });
  const s = await u.status();
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 2);
  assert.equal(s.diverged, true);
  assert.equal(s.commits[0].subject, 'Fix the thing');
  assert.equal(decide('apply', s).action, 'blocked');
  await assert.rejects(() => u.apply(), /diverged|by hand/);
});

test('a dirty tree blocks the merge before git is ever asked to merge', async () => {
  const { run, calls } = fakeGit({
    '--version': { code: 0, stdout: 'git version 2.43.0' },
    'rev-parse --show-toplevel': { code: 0, stdout: '/srv/bot' },
    'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'main' },
    'rev-parse HEAD': { code: 0, stdout: 'deadbeef' },
    'status --porcelain': { code: 0, stdout: ' M bot/panel/ui.js' },
  });
  const u = createUpdater({ cwd: '/srv/bot', run });
  await assert.rejects(() => u.apply(), /local changes/);
  assert.ok(!calls.includes('merge --ff-only origin/main'), 'no merge was attempted');
});

// --- against real repositories ------------------------------------------------

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  },
}).trim();

function makeRepos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-'));
  const origin = path.join(root, 'origin');
  const clone = path.join(root, 'clone');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ version: '1.2.0' }));
  fs.writeFileSync(path.join(origin, 'file.txt'), 'one\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-qm', 'first commit');
  git(root, 'clone', '-q', origin, clone);
  return { root, origin, clone };
}

test('a real checkout updates fast-forward and reports what changed', async () => {
  const { origin, clone } = makeRepos();

  fs.appendFileSync(path.join(origin, 'file.txt'), 'two\n');
  git(origin, 'commit', '-qam', 'second: add a line');
  fs.writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ version: '1.3.0' }));
  git(origin, 'commit', '-qam', 'third: bump version');

  const u = createUpdater({ cwd: clone });
  const state = await u.check();
  assert.equal(state.isRepo, true);
  assert.equal(state.behind, 2, 'two commits behind');
  assert.equal(state.commits.length, 2);
  assert.match(state.commits[0].subject, /bump version/, 'newest first');

  const result = await u.apply();
  assert.equal(result.updated, true);
  assert.notEqual(result.from, result.to, 'a new commit is running');
  assert.equal(fs.readFileSync(path.join(clone, 'file.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(readVersion(clone), '1.3.0', 'package.json came along');

  const after = await u.status();
  assert.equal(after.behind, 0);
  assert.match(describeStatus(after), /up to date/);

  // Applying again is a no-op, not an error.
  const again = await u.apply();
  assert.equal(again.updated, false);
  assert.match(again.message, /Already up to date/);
});

test('a real rollback restores the commit that was running', async () => {
  const { origin, clone } = makeRepos();
  const before = git(clone, 'rev-parse', 'HEAD');

  fs.appendFileSync(path.join(origin, 'file.txt'), 'two\n');
  git(origin, 'commit', '-qam', 'second');

  const u = createUpdater({ cwd: clone });
  const applied = await u.apply();
  assert.equal(applied.updated, true);

  const back = await u.rollback();
  assert.equal(back.rolledBackTo, before);
  assert.equal(fs.readFileSync(path.join(clone, 'file.txt'), 'utf8'), 'one\n', 'the file is back');
});

test('local changes are never destroyed by an update', async () => {
  const { origin, clone } = makeRepos();
  fs.writeFileSync(path.join(clone, 'file.txt'), 'work in progress\n');

  fs.appendFileSync(path.join(origin, 'file.txt'), 'two\n');
  git(origin, 'commit', '-qam', 'second');

  const u = createUpdater({ cwd: clone });
  await assert.rejects(() => u.apply(), /local changes/);
  assert.equal(fs.readFileSync(path.join(clone, 'file.txt'), 'utf8'), 'work in progress\n', 'the edit survived');
  await assert.rejects(() => u.rollback(), /local changes/);
});

test('a diverged branch is refused rather than merged', async () => {
  const { origin, clone } = makeRepos();
  fs.appendFileSync(path.join(origin, 'file.txt'), 'upstream\n');
  git(origin, 'commit', '-qam', 'upstream change');

  fs.writeFileSync(path.join(clone, 'mine.txt'), 'local commit\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'local change');

  const u = createUpdater({ cwd: clone });
  const state = await u.check();
  assert.equal(state.diverged, true);
  assert.equal(state.ahead, 1);
  await assert.rejects(() => u.apply(), /by hand/);
});
