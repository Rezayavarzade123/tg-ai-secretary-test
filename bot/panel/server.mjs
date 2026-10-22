// The control panel: a small HTTP server with a single-page UI.
//
// It runs in the same process as the bot, so it can read the live state instead of
// guessing from files. It writes exactly the same settings the Telegram commands
// write — one database, two front doors.
//
// Security: it is meant for your own network. It prints a random access token on
// first run and stores it in bot/state/panel-token; the URL includes it once, then
// a cookie is used. Nothing here is exposed to the internet by itself.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { db } from 'sdk';
import { eq, asc, desc } from 'sdk/db';
import { notes, drafts, settings } from '../../tgcloud/schema.js';
import { getSetting, setSetting, delSetting } from '../../tgcloud/lib/settings.js';
import { listDrafts, getDraft, sendDraft, ignoreDraft, regenerateDraft, countPendingDrafts } from '../../tgcloud/lib/drafts.js';
import { health, llmQueue } from '../../tgcloud/lib/llm.js';
import { modelSettings, respond, defaultPrompt } from '../../tgcloud/lib/brain.js';
import { LANGUAGES, isLanguage } from '../../tgcloud/lib/lang.js';
import { recentActivity, logActivity } from '../../tgcloud/lib/activity.js';
import { ownerId, ownerName } from '../../tgcloud/lib/owner.js';
import { getStateFile, stats, backup } from '../sdk/store.mjs';
import { runtime, uptimeSeconds, log } from '../runtime.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(HERE, 'ui.html');

let ACCESS_TOKEN = process.env.PANEL_TOKEN || '';

function tokenFile() {
  return path.join(path.dirname(getStateFile()), 'panel-token');
}

function ensureToken() {
  if (ACCESS_TOKEN) return ACCESS_TOKEN;
  const file = tokenFile();
  try {
    if (fs.existsSync(file)) {
      ACCESS_TOKEN = fs.readFileSync(file, 'utf8').trim();
      if (ACCESS_TOKEN) return ACCESS_TOKEN;
    }
  } catch { /* fall through */ }
  ACCESS_TOKEN = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ACCESS_TOKEN, { mode: 0o600 });
  return ACCESS_TOKEN;
}

function authed(req, url) {
  if (!ACCESS_TOKEN) return true;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ') && header.slice(7).trim() === ACCESS_TOKEN) return true;
  const given = url.searchParams.get('token');
  if (given && timingSafeEqual(given, ACCESS_TOKEN)) return true;
  const cookie = req.headers.cookie || '';
  const m = /(?:^|;\s*)panel_token=([^;]+)/.exec(cookie);
  if (m && timingSafeEqual(decodeURIComponent(m[1]), ACCESS_TOKEN)) return true;
  return false;
}

// Opening the panel with ?token=… signs you in: the cookie is set on that
// response, so the single-page app's later /api calls are authenticated too.
function maybeSetCookie(req, res, url) {
  const given = url.searchParams.get('token');
  if (!ACCESS_TOKEN || !given) return;
  if (!timingSafeEqual(given, ACCESS_TOKEN)) return;
  res.setHeader('Set-Cookie', `panel_token=${encodeURIComponent(ACCESS_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// --- helpers -------------------------------------------------------------------

class BadRequest extends Error {}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function readBody(req, limit = 1024 * 200) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function readTemps() {
  const out = [];
  try {
    const base = '/sys/class/hwmon';
    for (const entry of fs.readdirSync(base)) {
      const dir = path.join(base, entry);
      let name = entry;
      try { name = fs.readFileSync(path.join(dir, 'name'), 'utf8').trim() || entry; } catch { /* ignore */ }
      for (const f of fs.readdirSync(dir)) {
        if (!/^temp\d+_input$/.test(f)) continue;
        try {
          const raw = Number(fs.readFileSync(path.join(dir, f), 'utf8').trim());
          if (Number.isFinite(raw) && raw > 0 && raw < 150000) out.push({ sensor: name, celsius: Math.round(raw / 1000) });
        } catch { /* ignore */ }
      }
    }
  } catch { /* no hwmon on this machine */ }
  return out.sort((a, b) => b.celsius - a.celsius).slice(0, 4);
}

const SECRET_KEYS = new Set(['bot_token', 'llm_api_key', 'ollama_key']);

async function readSettings() {
  const rows = await db.select().from(settings).all();
  const out = {};
  for (const r of rows) {
    if (SECRET_KEYS.has(r.key)) continue;
    out[r.key] = r.value;
  }
  return out;
}

// --- state ---------------------------------------------------------------------

async function buildState() {
  const ms = await modelSettings();
  const llm = await health({ baseUrl: ms.baseUrl, apiKey: ms.apiKey });
  const settingsMap = await readSettings();
  const mem = { total: os.totalmem(), free: os.freemem() };
  const d = await countPendingDrafts().catch(() => 0);

  return {
    version: '1.1.0',
    now: Date.now(),
    uptime: uptimeSeconds(),
    pid: process.pid,
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    polling: runtime.polling,
    lastUpdateAt: runtime.lastUpdateAt,
    lastError: runtime.lastError,
    lastErrorAt: runtime.lastErrorAt,
    counts: runtime.counts,
    bot: runtime.bot ? { id: runtime.bot.id, username: runtime.bot.username, firstName: runtime.bot.first_name } : null,
    owner: { id: await ownerId(), name: await ownerName() },
    panelUrl: runtime.panelUrl,
    hasPanelToken: Boolean(ACCESS_TOKEN),
    model: { provider: ms.provider, baseUrl: ms.baseUrl, name: ms.model },
    llm,
    queue: { ...llmQueue },
    system: {
      loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      cpus: os.cpus().length,
      mem,
      temps: readTemps(),
    },
    state: stats(),
    draftsPending: d,
    languages: LANGUAGES,
    settings: settingsMap,
    secrets: {
      botToken: Boolean(process.env.BOT_TOKEN),
      apiKey: Boolean(ms.apiKey),
    },
  };
}

// --- settings writes -------------------------------------------------------------

const BOOL = new Set(['lang_auto', 'notify', 'secretary', 'debug']);
const NUMERIC = { delay_seconds: [0, 300], pause_hours: [0, 168] };

const invalid = (m) => new BadRequest(m);

async function applySetting(key, rawValue) {
  const value = rawValue === null || rawValue === undefined ? '' : String(rawValue);

  switch (key) {
    case 'bot_token': {
      const token = value.trim();
      if (token && !/^\d+:[\w-]{20,}$/.test(token)) throw invalid('That does not look like a bot token (expected 123456789:AA...).');
      if (token) await setSetting('bot_token', token);
      else await delSetting('bot_token');
      if (runtime.onTokenChange) await runtime.onTokenChange(token);
      return { restarted: true };
    }
    case 'owner_id': {
      if (value && !/^\d+$/.test(value.trim())) throw invalid('The owner id is a number (send /id to the bot).');
      if (value) await setSetting('owner_id', value.trim());
      else await delSetting('owner_id');
      runtime.ownerId = await ownerId();
      return {};
    }
    case 'llm_api_key': {
      if (value.trim()) await setSetting('llm_api_key', value.trim());
      else await delSetting('llm_api_key');
      return {};
    }
    case 'llm_provider': {
      if (!['local', 'cloud'].includes(value)) throw invalid('provider must be local or cloud');
      await setSetting('llm_provider', value);
      return {};
    }
    case 'llm_base_url': {
      if (!/^https?:\/\/[^\s]+$/i.test(value)) throw invalid('The server URL must start with http:// or https://');
      await setSetting('llm_base_url', value.replace(/\/+$/, ''));
      return {};
    }
    case 'model': {
      if (value.length > 120) throw invalid('Model name is too long');
      if (value) await setSetting('model', value); else await delSetting('model');
      return {};
    }
    case 'lang': {
      if (!isLanguage(value)) throw invalid('Unknown language code');
      await setSetting('lang', value);
      return {};
    }
    case 'lang_auto': {
      if (!['on', 'off'].includes(value)) throw invalid('lang_auto must be on or off');
      await setSetting('lang_auto', value);
      return {};
    }
    case 'secretary_mode': {
      if (!['draft', 'auto', 'off'].includes(value)) throw invalid('secretary_mode must be draft, auto or off');
      await setSetting('secretary_mode', value);
      await setSetting('secretary', value === 'off' ? 'off' : 'on');
      return {};
    }
    case 'secretary': {
      if (!['on', 'off'].includes(value)) throw invalid('secretary must be on or off');
      await setSetting('secretary', value);
      if (value === 'off') await setSetting('secretary_mode', 'off');
      else if ((await getSetting('secretary_mode', 'off')) === 'off') await setSetting('secretary_mode', 'draft');
      return {};
    }
    case 'timezone': {
      if (!value) { await delSetting('timezone'); return {}; }
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone: value });
      } catch {
        throw invalid('Unknown timezone. Use an IANA name such as Europe/London.');
      }
      await setSetting('timezone', value);
      return {};
    }
    case 'secretary_info': {
      if (value.length > 2000) throw invalid('Keep /secretaryinfo under 2000 characters');
      if (value) await setSetting('secretary_info', value); else await delSetting('secretary_info');
      return {};
    }
    default: {
      if (NUMERIC[key]) {
        const n = Number(value);
        const [min, max] = NUMERIC[key];
        if (!Number.isFinite(n) || n < min || n > max) throw invalid(`${key} must be between ${min} and ${max}`);
        await setSetting(key, String(Math.round(n)));
        return {};
      }
      if (BOOL.has(key)) {
        if (!['on', 'off'].includes(value)) throw invalid(`${key} must be on or off`);
        await setSetting(key, value);
        return {};
      }
      throw invalid(`Setting "${key}" cannot be changed from the panel`);
    }
  }
}

// --- router ----------------------------------------------------------------------

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};

  if (route === 'GET /api/ping') {
    return json(res, 200, { ok: true, needsAuth: Boolean(ACCESS_TOKEN) && !authed(req, url), version: '1.1.0' });
  }
  if (route === 'POST /api/login') {
    if (!ACCESS_TOKEN || timingSafeEqual(body.token ?? '', ACCESS_TOKEN)) {
      res.setHeader('Set-Cookie', `panel_token=${encodeURIComponent(ACCESS_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
      return json(res, 200, { ok: true });
    }
    return json(res, 401, { error: 'Wrong token. It is printed when the bot starts, and stored in bot/state/panel-token.' });
  }

  if (!authed(req, url)) return json(res, 401, { error: 'Unauthorised' });

  if (route === 'GET /api/state') return json(res, 200, await buildState());

  if (route === 'GET /api/settings') {
    return json(res, 200, {
      settings: await readSettings(),
      languages: LANGUAGES,
      defaults: {
        lang: 'en',
        lang_auto: 'on',
        secretary_mode: 'draft',
        delay_seconds: 50,
        pause_hours: 4,
        notify: 'on',
      },
    });
  }

  if (route === 'POST /api/settings') {
    const entries = body.key ? [[body.key, body.value]] : Object.entries(body.settings ?? {});
    if (!entries.length) return json(res, 400, { error: 'No settings in the request' });
    const results = {};
    for (const [key, value] of entries) {
      try {
        results[key] = await applySetting(key, value);
      } catch (e) {
        if (e instanceof BadRequest || /must|Unknown|look like|Too long|between/.test(e.message)) {
          return json(res, 400, { error: e.message });
        }
        throw e;
      }
      await logActivity('info', `Panel: ${key} updated`);
    }
    return json(res, 200, { ok: true, results, state: await buildState() });
  }

  if (route === 'GET /api/prompts') {
    const owner = await ownerName();
    return json(res, 200, {
      bot: { custom: await getSetting('prompt_bot', ''), default: defaultPrompt('bot', owner) },
      secretary: { custom: await getSetting('prompt_secretary', ''), default: defaultPrompt('secretary', owner) },
    });
  }

  if (route === 'POST /api/prompts') {
    const mode = body.mode === 'secretary' ? 'secretary' : 'bot';
    const text = String(body.text ?? '');
    const key = `prompt_${mode}`;
    if (text.length > 10000) return json(res, 400, { error: 'The limit is 10,000 characters' });
    if (text.trim()) await setSetting(key, text.trim()); else await delSetting(key);
    await logActivity('info', `Panel: ${mode} prompt ${text.trim() ? 'updated' : 'reset'}`);
    return json(res, 200, { ok: true });
  }

  if (route === 'GET /api/notes') {
    return json(res, 200, { notes: await db.select().from(notes).orderBy(asc(notes.id)).all() });
  }
  if (route === 'POST /api/notes') {
    const text = String(body.text ?? '').trim();
    if (!text) return json(res, 400, { error: 'Empty note' });
    const [row] = await db.insert(notes).values({ text }).returning().run();
    return json(res, 200, { ok: true, note: row });
  }
  if (req.method === 'DELETE' && /^\/api\/notes\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/').pop());
    await db.delete(notes).where(eq(notes.id, id)).run();
    return json(res, 200, { ok: true });
  }

  if (route === 'GET /api/drafts') {
    const status = url.searchParams.get('status') || 'pending';
    const rows = await listDrafts({ status, limit: 50 });
    return json(res, 200, { drafts: rows });
  }
  const draftAction = /^\/api\/drafts\/(\d+)\/(send|ignore|regen)$/.exec(url.pathname);
  if (req.method === 'POST' && draftAction) {
    const id = Number(draftAction[1]);
    const action = draftAction[2];
    if (action === 'send') {
      const out = await sendDraft(id, { text: body.text });
      return json(res, 200, { ok: true, draft: out });
    }
    if (action === 'ignore') return json(res, 200, { ok: true, draft: await ignoreDraft(id) });
    if (action === 'regen') return json(res, 200, { ok: true, draft: await regenerateDraft(id) });
  }
  if (req.method === 'PUT' && /^\/api\/drafts\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/').pop());
    const d = await getDraft(id);
    if (!d) return json(res, 404, { error: 'Draft not found' });
    const text = String(body.text ?? '').trim();
    if (!text) return json(res, 400, { error: 'Empty draft' });
    await db.insert(drafts).values({ id, answer: text }).onConflictDoUpdate({ target: drafts.id, set: { answer: text } }).run();
    return json(res, 200, { ok: true, draft: await getDraft(id) });
  }

  if (route === 'GET /api/activity') {
    return json(res, 200, { activity: await recentActivity(80) });
  }
  if (route === 'GET /api/log') {
    return json(res, 200, { log: runtime.log.slice(-120).reverse() });
  }

  if (route === 'POST /api/test-model') {
    const text = String(body.text ?? 'Hello! In one short sentence, say what you are.').slice(0, 500);
    const started = Date.now();
    try {
      const answer = await respond({ scope: 'panel-test', userText: text, mode: 'bot', remember: false });
      return json(res, 200, { ok: true, answer, ms: Date.now() - started });
    } catch (e) {
      return json(res, 200, { ok: false, error: e?.message ?? String(e), ms: Date.now() - started });
    }
  }

  if (route === 'POST /api/backup') {
    const file = backup(30);
    return json(res, 200, { ok: Boolean(file), file });
  }

  if (route === 'POST /api/send-test') {
    const owner = await ownerId();
    if (!owner) return json(res, 400, { error: 'No owner set yet' });
    const { api } = await import('../sdk/telegram.mjs');
    await api.sendMessage({ chat_id: owner, text: '✅ Test message from the control panel. The bot can reach Telegram.' });
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: `Unknown endpoint ${route}` });
}

export async function startPanel({ port = 8787, host = '0.0.0.0', lanAddress = '127.0.0.1' } = {}) {
  ensureToken();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    maybeSetCookie(req, res, url);
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url)
        .catch((e) => {
          if (!res.headersSent) json(res, 500, { error: e?.message ?? String(e) });
          log('error', `panel: ${e?.message ?? e}`);
        });
      return;
    }
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });

    // Everything else is the single-page app.
    fs.readFile(UI_FILE, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('ui.html is missing next to panel/server.mjs');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });

  await new Promise((resolve) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        log('warn', `panel port ${port} is already in use — the bot keeps running without the panel. Set PANEL_PORT to change it.`);
      } else {
        log('error', `panel failed to start: ${e.message}`);
      }
      resolve();
    });
    server.listen(port, host, () => {
      const actual = server.address()?.port ?? port;
      runtime.panelPort = actual;
      runtime.panelUrlPublic = `http://${lanAddress}:${actual}`;
      runtime.panelUrl = `${runtime.panelUrlPublic}/?token=${ACCESS_TOKEN}`;
      log('info', `control panel on http://${host === '0.0.0.0' ? lanAddress : host}:${actual}  (token in bot/state/panel-token)`);
      resolve();
    });
  });

  return server;
}
