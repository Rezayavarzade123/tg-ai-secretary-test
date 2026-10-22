#!/usr/bin/env node
//
// cli.mjs — the parts of the command line that are the same everywhere.
//
// `bin/tg-secretary` (bash) and `bin/tg-secretary.ps1` (PowerShell) are thin front
// ends for the platform-specific half: systemd versus a scheduled task, `journalctl`
// versus a log file. Everything below is plain Node, so there is one implementation
// of "what is on GitHub" and no quoting games across two shells.
//
//   node bot/cli.mjs version
//   node bot/cli.mjs update | update check | update apply | update rollback
//
// Exit codes: 0 fine, 1 the thing could not be done, 2 usage.

import { createUpdater, describeStatus, readVersion } from './updater.mjs';

const [, , command = 'version', action = ''] = process.argv;

function usage(code = 2) {
  console.log(`usage: node bot/cli.mjs <command>

  version                 installed version, from package.json
  update [check]          what is on GitHub, and what is installed
  update apply            fast-forward this checkout
  update rollback         go back to the commit that ran before the last apply
`);
  process.exit(code);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function update(kind) {
  const updater = createUpdater({ cwd: process.cwd() });

  if (kind === '' || kind === 'check') {
    const state = await updater.check();
    console.log(describeStatus(state));
    for (const c of (state.commits || []).slice(0, 8)) {
      console.log(`  • ${c.subject} — ${c.author}, ${c.when}`);
    }
    if (state.behind) console.log('\nInstall it:  tg-secretary update apply');
    // A checkout that cannot update at all is a failure, not a status: scripts and
    // people both branch on this.
    process.exit(state.isRepo && state.gitAvailable !== false ? 0 : 1);
  }

  if (kind === 'apply') {
    try {
      const result = await updater.apply();
      console.log(result.message);
      for (const c of (result.commits || []).slice(0, 8)) console.log(`  • ${c.subject}`);
      if (result.updated) console.log('\nRestart to run it:  tg-secretary restart');
      process.exit(0);
    } catch (e) {
      fail(`Not updated: ${e.message}`);
    }
  }

  if (kind === 'rollback') {
    try {
      const result = await updater.rollback();
      console.log(`${result.message}\n\nRestart to run it:  tg-secretary restart`);
      process.exit(0);
    } catch (e) {
      fail(`Could not roll back: ${e.message}`);
    }
  }

  console.error(`update: expected check, apply or rollback (got ${kind})`);
  process.exit(2);
}

switch (command) {
  case 'version':
    console.log(readVersion(process.cwd()));
    break;
  case 'update':
    await update(action);
    break;
  case 'help':
  case '--help':
  case '-h':
    usage(0);
    break;
  default:
    usage(1);
}
