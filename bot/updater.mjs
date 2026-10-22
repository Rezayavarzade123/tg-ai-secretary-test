// Updating from GitHub.
//
// The bot runs unattended on a box in a corner, so "how do I get the fixes I just
// pushed" needs an answer that is not "ssh in and pull". This module is that
// answer, and it is written defensively, because an auto-updater is a remote code
// execution path by construction: whoever can write to the branch it follows can
// run code on your machine as the user running the bot.
//
// The rules that follow from that:
//
//   1. **Fast-forward only.** The updater never merges, rebases or stashes. If the
//      checkout has local changes, or the history has diverged, it refuses and
//      says so. A half-applied update is worse than an old one.
//   2. **Checking is automatic, installing is a decision.** Every N hours it
//      fetches and reports. Installing happens when you press the button, or when
//      you explicitly turn on auto-install — which is a separate switch with a
//      separate warning, not something you get by accident.
//   3. **Every update is reversible.** The commit that was running is recorded
//      before the merge, so `/update rollback` restores it.
//   4. **Nothing is invented.** "Up to date" means `git rev-list --count` said 0.
//      If git is unavailable, or the checkout is not a repository, it says that
//      instead of guessing a version.
//
// Everything that talks to git goes through an injected `run`, so the tests use a
// real temporary repository or a fake, never the developer's working copy.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GIT_TIMEOUT_MS = 60_000;

// --- pure helpers -------------------------------------------------------------

export const UPDATE_MODES = ['off', 'notify', 'apply'];

export function parseCount(text) {
  const n = Number(String(text ?? '').trim());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

// `git log --pretty=format:%h%x1f%s%x1f%an%x1f%cr` with a 0x1f separator, one
// commit per line. Chosen over JSON because it survives any subject text.
export function parseLog(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, author, when] = line.split('\x1f');
      return { sha: sha ?? '', subject: (subject ?? '').trim(), author: author ?? '', when: when ?? '' };
    })
    .filter((c) => c.sha);
}

// What to do about the state we just measured. Pure, so the policy is testable
// without a repository.
//   mode   : 'off' (do not check), 'notify' (tell the owner), 'apply' (install)
//   state  : { isRepo, gitAvailable, dirty, behind, diverged, inProgress, paused }
export function decide(mode, state) {
  if (mode === 'off') return { action: 'none', reason: 'automatic checks are off' };
  if (!state?.gitAvailable) return { action: 'none', reason: 'git is not installed on this machine' };
  if (!state?.isRepo) return { action: 'none', reason: 'this is not a git checkout' };
  if (state.paused) return { action: 'none', reason: 'automatic updates are paused' };
  if (state.inProgress) return { action: 'blocked', reason: 'a merge or rebase is already in progress' };
  if (state.dirty) {
    return {
      action: 'blocked',
      reason: 'there are local changes in the checkout — commit or discard them first',
    };
  }
  if (state.diverged) {
    return { action: 'blocked', reason: 'the local branch has commits that are not on the remote' };
  }
  if (!state.behind) return { action: 'none', reason: 'already up to date' };
  if (mode === 'apply') return { action: 'apply', reason: `${state.behind} update(s) available` };
  return { action: 'notify', reason: `${state.behind} update(s) available` };
}

export function describeStatus(s) {
  if (!s) return 'not checked yet';
  if (!s.gitAvailable) return 'git is not installed here, so updates cannot be checked';
  if (!s.isRepo) return 'this copy was not installed with git, so it cannot update itself';
  if (s.error) return `could not check: ${s.error}`;
  if (s.diverged) return 'the local branch has diverged from the remote — update by hand';
  if (s.dirty) return 'local changes in the checkout — an automatic update would lose them';
  if (!s.behind) return `up to date (${s.branch} at ${s.head?.slice(0, 7)})`;
  return `${s.behind} new commit(s) on ${s.remote}/${s.branch}`;
}

// --- the updater --------------------------------------------------------------

export function createUpdater({
  cwd = process.cwd(),
  run = defaultRun,
  remote = 'origin',
  branch,
  now = () => Date.now(),
} = {}) {
  let lastCheck = null;      // { at, state }
  let lastApply = null;      // { at, from, to, ok, error }

  const git = (args, options = {}) => run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS, ...options });
  const hasGit = makeHasGit(run);

  async function raw(args) {
    const r = await git(args);
    return { ok: r.code === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), code: r.code };
  }

  async function detectBranch() {
    if (branch) return branch;
    const r = await raw(['rev-parse', '--abbrev-ref', 'HEAD']);
    return r.ok && r.out && r.out !== 'HEAD' ? r.out : 'main';
  }

  async function status() {
    const version = readVersion(cwd);
    const base = { version, cwd, remote };

    if (!(await hasGit())) {
      return { ...base, gitAvailable: false, isRepo: false, checkedAt: now() };
    }

    const top = await raw(['rev-parse', '--show-toplevel']);
    if (!top.ok) return { ...base, gitAvailable: true, isRepo: false, checkedAt: now() };

    const br = await detectBranch();
    const head = await raw(['rev-parse', 'HEAD']);
    const dirtyOut = await raw(['status', '--porcelain', '--untracked-files=no']);
    const inProgress = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'].some((f) =>
      fs.existsSync(path.join(cwd, '.git', f))
    );
    const remoteUrl = await raw(['remote', 'get-url', remote]);

    const state = {
      ...base,
      gitAvailable: true,
      isRepo: true,
      branch: br,
      head: head.out || '',
      shortHead: (head.out || '').slice(0, 7),
      originUrl: remoteUrl.ok ? remoteUrl.out : '',
      dirty: Boolean(dirtyOut.out),
      // `status --porcelain` lines are "XY path": keep the path, and show the XY
      // only where it says something ("M" alone is ambiguous with a leading space).
      dirtyFiles: dirtyOut.out
        ? dirtyOut.out.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5)
        : [],
      inProgress,
      behind: 0,
      ahead: 0,
      diverged: false,
      commits: [],
      fetchedAt: 0,
      checkedAt: now(),
    };

    // Behind/ahead needs a fetched ref. If there is none, say so rather than
    // claiming "up to date".
    const counts = await raw(['rev-list', '--left-right', '--count', `HEAD...${remote}/${br}`]);
    if (counts.ok) {
      const [ahead, behind] = counts.out.split(/\s+/).map(parseCount);
      state.ahead = ahead;
      state.behind = behind;
      state.diverged = Boolean(ahead);
    } else {
      state.needsFetch = true;
    }

    if (state.behind) {
      // Only the commits we do not have yet: showing the whole branch would list
      // changes the owner already installed.
      const log = await raw(['log', '--pretty=format:%h%x1f%s%x1f%an%x1f%cr', '-n', '10', `HEAD..${remote}/${br}`]);
      state.commits = parseLog(log.out);
    }
    return state;
  }

  async function check() {
    const before = await status();
    if (!before.isRepo) {
      lastCheck = { at: now(), state: before };
      return before;
    }
    const fetch = await raw(['fetch', '--prune', '--quiet', remote]);
    const after = await status();
    const state = {
      ...after,
      fetchedAt: now(),
      needsFetch: false,
      ...(fetch.ok ? {} : { error: fetch.err || 'git fetch failed' }),
    };
    lastCheck = { at: now(), state };
    return state;
  }

  // Refuse anything that is not a clean fast-forward. Re-measured immediately
  // before touching the tree: the owner may have edited files since the check.
  async function apply() {
    const state = await status();
    if (!state.isRepo) throw new Error('This copy was not installed with git, so it cannot update itself.');
    if (state.dirty) throw new Error('The checkout has local changes. Commit or discard them first — an update would overwrite them.');
    if (state.inProgress) throw new Error('A merge or rebase is already in progress.');
    if (state.diverged) throw new Error('The local branch has commits that are not on the remote. Update by hand.');

    const fetched = await check();
    if (!fetched.isRepo) throw new Error('This copy was not installed with git, so it cannot update itself.');
    if (fetched.error) throw new Error(`Could not fetch from ${remote}: ${fetched.error}`);
    if (!fetched.behind) return { updated: false, from: state.head, to: state.head, commits: [], message: 'Already up to date.' };

    const from = state.head || fetched.head;
    const merge = await raw(['merge', '--ff-only', `${remote}/${fetched.branch}`]);
    if (!merge.ok) {
      lastApply = { at: now(), from, to: from, ok: false, error: merge.err || 'git merge failed' };
      throw new Error(`Update refused: ${merge.err || 'git merge failed'}. Nothing was changed.`);
    }
    const to = (await raw(['rev-parse', 'HEAD'])).out;
    lastApply = { at: now(), from, to, ok: true, commits: fetched.commits };
    return {
      updated: from !== to,
      from,
      to,
      commits: fetched.commits,
      message: from !== to ? `Updated ${from.slice(0, 7)} → ${to.slice(0, 7)}.` : 'Already up to date.',
    };
  }

  async function rollback(to) {
    const state = await status();
    if (!state.isRepo) throw new Error('Not a git checkout.');
    if (state.dirty) throw new Error('The checkout has local changes; refusing to reset over them.');
    const target = to || lastApply?.from;
    if (!target) throw new Error('No previous version recorded in this session. Pass a commit, or update by hand.');
    const reset = await raw(['reset', '--hard', target]);
    if (!reset.ok) throw new Error(`Rollback failed: ${reset.err || reset.code}`);
    const head = (await raw(['rev-parse', 'HEAD'])).out;
    return { rolledBackTo: head, message: `Rolled back to ${head.slice(0, 7)}.` };
  }

  return {
    status,
    check,
    apply,
    rollback,
    get lastCheck() { return lastCheck; },
    get lastApply() { return lastApply; },
  };
}

export function readVersion(cwd = process.cwd()) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return pkg.version || '';
  } catch {
    return '';
  }
}

function makeHasGit(run) {
  return async () => {
    const r = await run(['git', '--version'], { timeoutMs: 5000 });
    return r.code === 0;
  };
}

// The real exec. No shell, so nothing here can be word-split into a second
// command; a fixed argument list per call.
function defaultRun(args, { cwd, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(args[0], args.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}
