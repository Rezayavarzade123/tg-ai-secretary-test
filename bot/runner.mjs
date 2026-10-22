// The local runner: Telegram long polling + the three handlers from tgcloud/.
//
//   node --import ./bot/register.mjs bot/runner.mjs
//
// Why long polling instead of a webhook: a PS4 under a TV has no public HTTPS
// address, and polling needs no tunnel, no open port and no certificate. It also
// makes the bot impossible to reach from the internet, which is the right default
// for something that answers your private messages.

import os from 'node:os';
import { api, setBotToken, botToken } from './sdk/telegram.mjs';
import { load, save, backup, getStateFile } from './sdk/store.mjs';
import { getSetting, setSetting } from '../tgcloud/lib/settings.js';
import { ownerId } from '../tgcloud/lib/owner.js';
import { handleDraftCallback, countPendingDrafts } from '../tgcloud/lib/drafts.js';
import { logActivity } from '../tgcloud/lib/activity.js';
import { llmQueue } from '../tgcloud/lib/llm.js';
import { runtime, noteUpdate, noteError, log, uptimeSeconds } from './runtime.mjs';
import { startPanel } from './panel/server.mjs';
import messageHandler from '../tgcloud/handlers/message.js';
import businessMessageHandler from '../tgcloud/handlers/business_message.js';
import businessConnectionHandler from '../tgcloud/handlers/business_connection.js';

const ALLOWED_UPDATES = ['message', 'business_connection', 'business_message', 'callback_query'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lanAddress() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      candidates.push({ name, address: net.address });
    }
  }
  // Prefer a real LAN address over container/virtual bridges.
  const preferred = candidates.find((c) => !/^(docker|br-|veth|virbr|tun|tap|wg)/.test(c.name));
  return (preferred ?? candidates[0])?.address ?? '127.0.0.1';
}

function banner() {
  const url = runtime.panelUrlPublic || `http://${lanAddress()}:${runtime.panelPort}`;
  const lines = [
    '',
    '  Secretary — local runtime',
    '  ─────────────────────────────────────────────',
    `  bot        ${runtime.bot ? '@' + runtime.bot.username + ' (id ' + runtime.bot.id + ')' : 'not connected yet'}`,
    `  owner      ${runtime.ownerId || 'not set — send /claim in Telegram'}`,
    `  model      ${runtime.model} (${runtime.provider})`,
    `  server     ${runtime.baseUrl}`,
    `  panel      ${url}`,
    `  token      ${runtime.panelUrl && runtime.panelUrl.includes('token=') ? runtime.panelUrl.split('token=')[1] : '(see bot/state/panel-token)'}`,
    `  state      ${getStateFile()}`,
    '  ─────────────────────────────────────────────',
    '  Ctrl+C to stop.',
    '',
  ];
  console.log(lines.join('\n'));
}

// --- Telegram loop -------------------------------------------------------------

let offset = 0;
let stopped = false;
let tokenAtStart = '';

function dispatch(update) {
  if (update.message) {
    noteUpdate('message');
    run('message', () => messageHandler(update.message));
  } else if (update.business_message) {
    noteUpdate('business_message');
    run('business_message', () => businessMessageHandler(update.business_message));
  } else if (update.business_connection) {
    noteUpdate('business_connection');
    run('business_connection', () => businessConnectionHandler(update.business_connection));
  } else if (update.callback_query) {
    noteUpdate('callback_query');
    run('callback_query', () => handleDraftCallback(update.callback_query));
  } else {
    noteUpdate('other');
  }
}

// Every update gets its own task: the reply delay sleeps for up to 50 s inside
// business_message, and that must not hold up anybody else's message.
function run(where, fn) {
  Promise.resolve()
    .then(fn)
    .catch(async (e) => {
      noteError(where, e);
      log('error', `${where}: ${e?.description ?? e?.message ?? e}`);
      try { await logActivity('error', `${where}: ${e?.description ?? e?.message ?? e}`); } catch { /* ignore */ }
    });
}

async function pollLoop() {
  let backoff = 1000;
  while (!stopped) {
    const token = botToken();
    if (!token) {
      runtime.polling = false;
      await sleep(3000);
      continue;
    }
    if (token !== tokenAtStart) {
      tokenAtStart = token;
      offset = 0;
    }
    try {
      runtime.polling = true;
      const updates = await api.getUpdates({ offset, timeout: 25, allowed_updates: ALLOWED_UPDATES });
      runtime.polling = false;
      backoff = 1000;
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        dispatch(u);
      }
    } catch (e) {
      runtime.polling = false;
      noteError('poll', e);
      const desc = String(e?.description ?? e?.message ?? e);

      // 409 means a webhook is still registered, or another copy of the bot is polling.
      if (e?.status === 409) {
        log('warn', 'Telegram says a webhook or another poller is active. Removing the webhook and retrying…');
        try { await api.deleteWebhook({ drop_pending_updates: false }); } catch { /* ignore */ }
      } else if (/bot token|unauthorized/i.test(desc)) {
        log('error', 'The bot token was rejected. Fix BOT_TOKEN in bot/.env or in the control panel.');
      } else {
        log('error', `getUpdates failed: ${desc}`);
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

async function connectBot() {
  try {
    const me = await api.getMe();
    runtime.bot = me;
    log('info', `connected as @${me.username}`);
    await api.setMyCommands([
      { command: 'panel', description: 'How to open the control panel' },
      { command: 'status', description: 'Model, connection and mode' },
      { command: 'mode', description: 'draft | auto | off' },
      { command: 'lang', description: 'Reply language' },
      { command: 'secretaryinfo', description: 'What the secretary may share' },
      { command: 'notes', description: 'Private notes' },
      { command: 'help', description: 'All commands' },
    ]).catch(() => {});
    return me;
  } catch (e) {
    noteError('getMe', e);
    log('error', `cannot connect to Telegram: ${e?.description ?? e?.message ?? e}`);
    return null;
  }
}

// Called by the panel when the token or the owner changes.
runtime.onTokenChange = async (token) => {
  setBotToken(token);
  tokenAtStart = token;
  offset = 0;
  try { await api.deleteWebhook({ drop_pending_updates: false }); } catch { /* ignore */ }
  return connectBot();
};

// --- start up ------------------------------------------------------------------

async function main() {
  load();
  backup();
  log('info', `state file: ${getStateFile()}`);

  // One-off migration from environment to the database.
  if (process.env.BOT_OWNER_ID && !(await getSetting('owner_id'))) {
    await setSetting('owner_id', String(process.env.BOT_OWNER_ID));
  }

  if (process.env.BOT_TOKEN) await setSetting('bot_token', process.env.BOT_TOKEN).catch(() => {});
  const storedToken = await getSetting('bot_token', '');
  const token = botToken() || storedToken;
  if (!token) {
    log('warn', 'No bot token yet. Put BOT_TOKEN in bot/.env, or open the control panel and paste it.');
  } else {
    setBotToken(token);
    tokenAtStart = token;
  }

  runtime.ownerId = await ownerId();
  const { modelSettings } = await import('../tgcloud/lib/brain.js');
  const ms = await modelSettings();
  runtime.model = ms.model;
  runtime.provider = ms.provider;
  runtime.baseUrl = ms.baseUrl;

  if (token) {
    try { await api.deleteWebhook({ drop_pending_updates: false }); } catch (e) { log('warn', `deleteWebhook: ${e?.description ?? e?.message}`); }
    await connectBot();
  }

  runtime.panelPort = Number(process.env.PANEL_PORT ?? 8787);
  await startPanel({
    port: runtime.panelPort,
    host: process.env.PANEL_HOST || '0.0.0.0',
    lanAddress: lanAddress(),
  });
  await setSetting('panel_url', runtime.panelUrlPublic || `http://${lanAddress()}:${runtime.panelPort}`).catch(() => {});

  banner();
  if (await getSetting('secretary_mode', '') === '') {
    await setSetting('secretary_mode', 'draft');
  }

  const drafts = await countPendingDrafts().catch(() => 0);
  if (drafts) log('info', `${drafts} draft(s) waiting for approval`);
  log('info', `model queue idle=${!llmQueue.active}`);

  void pollLoop();

  const shutdown = async (sig) => {
    if (stopped) return;
    stopped = true;
    log('info', `${sig} received — stopping (saving state)`);
    try { save(); } catch { /* ignore */ }
    await sleep(300);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => {
    noteError('unhandledRejection', e);
    log('error', `unhandled rejection: ${e?.message ?? e}`);
  });

  // A heartbeat line every 10 minutes, so the log shows the box is alive.
  setInterval(() => {
    log('info', `alive ${Math.floor(uptimeSeconds() / 60)} min · updates ${JSON.stringify(runtime.counts)} · drafts ${'-'}`);
  }, 10 * 60 * 1000).unref?.();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
