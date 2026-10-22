// The control panel: a small HTTP server with a single-page UI.
//
// It runs in the same process as the bot, so it can read live state instead of
// guessing from files. It writes exactly the same settings the Telegram commands
// write — one database, two front doors.
//
// Security model (read this before exposing it):
//   * one shared token, printed at start-up, stored in bot/state/panel-token;
//   * a random token, a cookie, a strict CSP and frame-ancestors 'none';
//   * meant for your own network only. It is a control surface for an account
//     that can send messages as you: do not port-forward it.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { db } from 'sdk';
import { eq, asc } from 'sdk/db';
import { notes, settings } from '../../tgcloud/schema.js';
import { getSetting, setSetting, delSetting } from '../../tgcloud/lib/settings.js';
import { listDrafts, getDraft, sendDraft, ignoreDraft, regenerateDraft, updateDraftText, countPendingDrafts } from '../../tgcloud/lib/drafts.js';
import { health, llmQueue } from '../../tgcloud/lib/llm.js';
import { TIMEZONE, DEFAULT_LANG } from '../../tgcloud/lib/config.js';
import { modelSettings, respond, defaultPrompt } from '../../tgcloud/lib/brain.js';
import { LANGUAGES, isLanguage } from '../../tgcloud/lib/lang.js';
import { recentActivity, logActivity } from '../../tgcloud/lib/activity.js';
import { ownerId, ownerName } from '../../tgcloud/lib/owner.js';
import { listContacts, getContact, updateContact, NOTES_LIMIT } from '../../tgcloud/lib/contacts.js';
import { listFacts, deleteFact, setPinned, clearFacts, FACT_LIMIT } from '../../tgcloud/lib/memory.js';
import { metricsSummary, recentMetrics } from '../../tgcloud/lib/metrics.js';
import { parseWindow, describeWindow, inQuietHours } from '../../tgcloud/lib/hours.js';
import { runProbe, saveProbe, lastProbe, probeVerdict } from '../../tgcloud/lib/probe.js';
import { getStateFile, stats, backup, lockInfo } from '../sdk/store.mjs';
import { inspect as inspectMachine } from '../hardware.mjs';
import { verifyToken } from '../sdk/telegram.mjs';
import { runtime, uptimeSeconds, log } from '../runtime.mjs';
import { decide, describeStatus, readVersion } from '../updater.mjs';

// The machine report changes only when the hardware does (i.e. never), so it is
// read once a minute instead of on every poll.
let machineCache = null;
let machineAt = 0;
function machine() {
  if (!machineCache || Date.now() - machineAt > 60000) {
    machineCache = inspectMachine();
    machineAt = Date.now();
  }
  return machineCache;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = {
  '/': { file: 'ui.html', type: 'text/html; charset=utf-8' },
  '/ui.css': { file: 'ui.css', type: 'text/css; charset=utf-8' },
  '/ui.js': { file: 'ui.js', type: 'text/javascript; charset=utf-8' },
};

let ACCESS_TOKEN = process.env.PANEL_TOKEN || '';

// A demo instance is a panel running against bot/state-demo: fake contacts, fake
// drafts, no bot token, nothing private. It is started to look at the interface,
// so it signs itself in — a login screen in front of sample data is friction with
// no security value, and the token is already public (it is in the README).
// Real instances are unaffected: they never expose this.
let DEMO = process.env.PANEL_DEMO === '1' || /state-demo\/?$/.test(process.env.BOT_STATE_DIR || '');

// --- errors ---------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const gone = (m) => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);
const gateway = (m) => new HttpError(502, m);

// "Cannot reach Telegram", a 401 from it, a dead connection… none of these are the
// browser's fault, so they must not come back as 400.
function telegramFailure(e) {
  const msg = e?.message ?? String(e);
  return /telegram|cannot reach|unauthori[sz]ed|not enough rights|chat not found|blocked|connection/i.test(msg)
    ? gateway(msg)
    : bad(msg);
}

// --- token ------------------------------------------------------------------------
function tokenFile() {
  return path.join(path.dirname(getStateFile()), 'panel-token');
}

function ensureToken() {
  if (ACCESS_TOKEN) return ACCESS_TOKEN;
  const file = tokenFile();
  try {
    if (fs.existsSync(file)) {
      ACCESS_TOKEN = fs.readFileSync(file, 'utf8').trim();
      if (ACCESS_TOKEN) {
        try { fs.chmodSync(file, 0o600); } catch { /* not ours to change */ }
        return ACCESS_TOKEN;
      }
    }
  } catch { /* fall through and create one */ }
  ACCESS_TOKEN = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ACCESS_TOKEN, { mode: 0o600 });
  return ACCESS_TOKEN;
}

function sameSecret(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function authed(req, url) {
  // A demo instance is sample data with a published token, so it is open. This is
  // also the only form of authentication that cannot be broken by anything between
  // the browser and this process: an embedded preview pane was observed sending a
  // login POST with no body and no headers, which no amount of client-side care can
  // fix. There is nothing here worth a password.
  if (DEMO) return true;
  if (!ACCESS_TOKEN) return true;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ') && sameSecret(header.slice(7).trim(), ACCESS_TOKEN)) return true;
  const given = url.searchParams.get('token');
  if (given && sameSecret(given, ACCESS_TOKEN)) return true;
  const m = /(?:^|;\s*)panel_token=([^;]+)/.exec(req.headers.cookie || '');
  if (m && sameSecret(decodeURIComponent(m[1]), ACCESS_TOKEN)) return true;
  return false;
}

// Opening /?token=… signs you in, so the page's own fetches are authenticated.
function maybeSetCookie(url, res) {
  const given = url.searchParams.get('token');
  if (!ACCESS_TOKEN || !given || !sameSecret(given, ACCESS_TOKEN)) return;
  res.setHeader('Set-Cookie', `panel_token=${encodeURIComponent(ACCESS_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
}

// --- login throttling ---------------------------------------------------------------
const loginFails = new Map();     // ip -> { count, until }
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILS = 8;

function ipOf(req) {
  return req.socket?.remoteAddress ?? 'unknown';
}

function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.until && rec.until > now) return rec.until - now;
  // Keep the record while it is still inside the counting window; only forget it
  // once it is old enough to be irrelevant. (Deleting on every call reset the
  // counter, which made the limit impossible to reach.)
  if (now - rec.since > LOGIN_WINDOW_MS * 6) {
    loginFails.delete(ip);
    return 0;
  }
  return 0;
}

function noteLoginFailure(ip) {
  const now = Date.now();
  const rec = loginFails.get(ip) ?? { count: 0, since: now, until: 0 };
  if (now - rec.since > LOGIN_WINDOW_MS) { rec.count = 0; rec.since = now; }
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILS) rec.until = now + LOGIN_WINDOW_MS * 5;
  if (loginFails.size > 500) loginFails.clear();   // a silly number of addresses
  loginFails.set(ip, rec);
}

// --- plumbing --------------------------------------------------------------------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // The page loads its script and stylesheet as files, so no inline JS is needed.
  // Inline *style attributes* are still allowed (they are only cosmetic).
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function json(res, status, body) {
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(body));
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(bad('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(bad('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Writes must come from the panel itself: blocks a hostile page on the same LAN
// from posting to it (belt and braces next to SameSite=Strict).
//
// The naive version of this — "Origin must equal the Host header" — breaks behind
// anything that rewrites Host, which is most reverse proxies and every hosted
// preview URL. The symptom is that the page loads (GET is exempt) but the login
// POST is refused, so the panel rejects a correct token and shows the box again.
// Three things fix that without weakening the check:
//
//   1. Browsers send Sec-Fetch-Site, and pages cannot set it (forbidden header).
//      "same-origin" means the document and this request share an origin, which
//      is exactly what we want to know — regardless of what the proxy did to Host.
//   2. Proxies that do forward the original host put it in X-Forwarded-Host.
// Why a sign-in failed, in words, without writing the secret to the log. "Wrong
// token" with no detail sent us looking at cookies and proxies for two rounds when
// the request body had simply not arrived; the three facts below would have said so.
function describeBadToken(given, inBody, inHeader) {
  if (!given) return inBody === '' && !inHeader ? ' (no token arrived in the request at all)' : ' (empty token)';
  const bits = [`${given.length} characters`];
  const ascii = /^[\x20-\x7e]+$/.test(given);
  if (!ascii) bits.push('not plain ASCII — check the keyboard layout');
  else if (ACCESS_TOKEN && given.toLowerCase() === ACCESS_TOKEN.toLowerCase()) bits.push('differs only in capitalisation');
  else if (given.trim() !== given) bits.push('has surrounding spaces');
  if (!inBody && inHeader) bits.push('body was empty, header was used');
  return ` (${bits.join('; ')})`;
}

const SESSION_ROUTES = new Set(['POST /api/login', 'POST /api/logout']);

function checkOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) return;                                  // curl / scripts: no Origin header

  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'same-origin') return;

  try {
    const o = new URL(origin);
    const forwarded = String(req.headers['x-forwarded-host'] || '').split(',').map((h) => h.trim().toLowerCase());
    const hosts = [req.headers.host, ...forwarded].filter(Boolean).map((h) => String(h).toLowerCase());
    if (hosts.includes(o.host.toLowerCase())) return;    // same origin, Host intact
    if (['127.0.0.1', 'localhost', '::1'].includes(o.hostname) && hosts.some((h) => h.includes(o.hostname))) return;
  } catch { /* malformed Origin */ }

  log('warn', `panel: refused a ${req.method} from origin ${origin} (host ${req.headers.host || '?'})`);
  throw new HttpError(403, `Cross-origin requests are not allowed (origin ${origin}, host ${req.headers.host || '?'}).`);
}

// --- system info -------------------------------------------------------------------
function readMem() {
  const total = os.totalmem();
  let free = os.freemem();
  let available = free;
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(info);
    if (m) available = Number(m[1]) * 1024;
    else {
      const f = /^MemFree:\s+(\d+) kB/m.exec(info);
      if (f) free = Number(f[1]) * 1024;
    }
  } catch { /* not Linux, or no procfs */ }
  // `used` is the honest number: total minus what the kernel says can still be given out.
  return { total, free, available, used: Math.max(0, total - available) };
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

// --- health cache --------------------------------------------------------------------
// The UI polls every 5 s; without this each poll would ask the model server again.
// On a one-slot, slow CPU that is real load for no new information.
let healthCache = { at: 0, key: '', value: null };
async function cachedHealth({ baseUrl, apiKey }) {
  const key = `${baseUrl}|${apiKey ? 'k' : ''}`;
  const fresh = Date.now() - healthCache.at < 3000;
  if (fresh && healthCache.key === key) return healthCache.value;
  const value = await health({ baseUrl, apiKey });
  healthCache = { at: Date.now(), key, value };
  return value;
}

// --- settings ---------------------------------------------------------------------
const SECRET_KEYS = new Set(['bot_token', 'llm_api_key', 'ollama_key', 'secretary_conns']);
const BOOL = new Set(['lang_auto', 'notify', 'secretary']);
const NUMERIC = { delay_seconds: [0, 300], pause_hours: [0, 168] };

async function readSettings() {
  const rows = await db.select().from(settings).all();
  const out = Object.create(null);
  for (const r of rows) {
    if (SECRET_KEYS.has(r.key)) continue;
    out[r.key] = r.value;
  }
  return { ...out };
}

// Phase 1: validate everything, change nothing.
// Phase 2: write. Doing it in that order means a request with one bad field cannot
// leave half of its changes applied (that used to happen: a rejected language still
// saved the new reply delay).
function validateSetting(key, rawValue) {
  if (rawValue === null || rawValue === undefined) throw bad(`"${key}" needs a value`);
  const value = String(rawValue);
  if (value.length > 10000) throw bad(`"${key}" is too long`);

  switch (key) {
    case 'bot_token':
      if (value && !/^\d+:[\w-]{20,}$/.test(value.trim())) throw bad('That does not look like a bot token (expected 123456789:AA…).');
      return value.trim();
    case 'owner_id':
      if (value && !/^\d+$/.test(value.trim())) throw bad('The owner id is a number — send /id to the bot.');
      return value.trim();
    case 'llm_api_key': return value.trim();
    case 'llm_provider':
      if (!['local', 'cloud'].includes(value)) throw bad('provider must be local or cloud');
      return value;
    case 'llm_base_url':
      if (!/^https?:\/\/[^\s]+$/i.test(value)) throw bad('The server URL must start with http:// or https://');
      return value.replace(/\/+$/, '');
    case 'model':
      if (value.length > 120) throw bad('Model name is too long');
      return value;
    case 'lang':
      if (!isLanguage(value)) throw bad('Unknown language code');
      return value;
    case 'secretary_mode':
      if (!['draft', 'auto', 'off'].includes(value)) throw bad('secretary_mode must be draft, auto or off');
      return value;
    case 'secretary':
      if (!['on', 'off'].includes(value)) throw bad('secretary must be on or off');
      return value;
    case 'update_check':
      if (!['on', 'off'].includes(value)) throw bad('update_check must be on or off');
      return value;
    case 'update_mode':
      if (!['off', 'notify', 'apply'].includes(value)) throw bad('update_mode must be off, notify or apply');
      return value;
    case 'update_branch':
      if (value && !/^[\w./-]{1,100}$/.test(value)) throw bad('That is not a branch name.');
      return value;
    case 'inline_mode':
      // "owner" = the owner can use @bot in any chat; anyone else gets nothing.
      // There is no public mode on purpose: the bot prompt holds private notes.
      if (!['owner', 'off'].includes(value)) throw bad('inline_mode must be owner or off');
      return value;
    case 'group_mode':
      // "on" means the bot answers in groups when it is addressed, and only then.
      if (!['on', 'off'].includes(value)) throw bad('group_mode must be on or off');
      return value;
    case 'timezone':
      if (!value) return '';
      try { new Intl.DateTimeFormat('en-GB', { timeZone: value }); } catch { throw bad('Unknown timezone. Use an IANA name such as Europe/London.'); }
      return value;
    case 'secretary_info':
      if (value.length > 2000) throw bad('Keep the shareable information under 2000 characters');
      return value;
    case 'quiet_start':
    case 'quiet_end': {
      if (value === '') return '';
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 23) throw bad('Quiet hours are whole hours between 0 and 23 (or empty for off).');
      return String(n);
    }
    default:
      if (NUMERIC[key]) {
        if (value.trim() === '') throw bad(`${key} needs a number`);
        const n = Number(value);
        const [min, max] = NUMERIC[key];
        if (!Number.isFinite(n) || n < min || n > max) throw bad(`${key} must be between ${min} and ${max}`);
        return String(Math.round(n));
      }
      if (BOOL.has(key)) {
        if (!['on', 'off'].includes(value)) throw bad(`${key} must be on or off`);
        return value;
      }
      throw bad(`"${key}" cannot be changed from the panel`);
  }
}

async function applySetting(key, value, { force = false } = {}) {
  switch (key) {
    case 'bot_token': {
      // Verify first: a token that Telegram rejects must never replace a working one.
      if (!value) {
        await delSetting('bot_token');
        if (runtime.onTokenChange) await runtime.onTokenChange('');
        return { token: 'cleared' };
      }
      let me;
      try {
        me = await verifyToken(value);
      } catch (e) {
        throw bad(`Telegram rejected that token: ${e?.description ?? e?.message ?? e}`);
      }
      await setSetting('bot_token', value);
      const connected = runtime.onTokenChange ? await runtime.onTokenChange(value) : null;
      return { token: 'verified', bot: me?.username ?? null, connected: connected !== null };
    }
    case 'owner_id':
      if (value) await setSetting('owner_id', value); else await delSetting('owner_id');
      runtime.ownerId = await ownerId();
      return {};
    case 'llm_api_key':
      if (value) await setSetting('llm_api_key', value); else await delSetting('llm_api_key');
      healthCache = { at: 0, key: '', value: null };
      return {};
    case 'llm_provider':
      await setSetting('llm_provider', value);
      healthCache = { at: 0, key: '', value: null };
      return {};
    case 'llm_base_url':
      await setSetting('llm_base_url', value);
      healthCache = { at: 0, key: '', value: null };
      return {};
    case 'model':
      if (value) await setSetting('model', value); else await delSetting('model');
      return {};
    case 'timezone':
      if (value) await setSetting('timezone', value); else await delSetting('timezone');
      return {};
    case 'quiet_start':
    case 'quiet_end': {
      const other = key === 'quiet_start' ? await getSetting('quiet_end', '') : await getSetting('quiet_start', '');
      const pair = key === 'quiet_start' ? parseWindow(value, other) : parseWindow(other, value);
      if (value !== '' && other !== '' && !pair) {
        throw bad('Those two hours are the same, which would mean "quiet all day". Pick a different one.');
      }
      if (value) await setSetting(key, value); else await delSetting(key);
      return {};
    }
    case 'secretary_mode': {
      // Same gate as /mode auto: auto mode needs a recent, passing probe.
      if (value === 'auto' && !force) {
        const verdict = await probeVerdict();
        if (!verdict.ok) {
          throw new HttpError(409, `Auto mode is locked: ${verdict.reason}. Run the probe first, or confirm to override.`);
        }
      }
      await setSetting('secretary_mode', value);
      await setSetting('secretary', value === 'off' ? 'off' : 'on');
      return {};
    }
    case 'secretary':
      await setSetting('secretary', value);
      if (value === 'off') await setSetting('secretary_mode', 'off');
      else if ((await getSetting('secretary_mode', 'off')) === 'off') await setSetting('secretary_mode', 'draft');
      return {};
    default:
      if (key === 'lang' || BOOL.has(key) || NUMERIC[key]) {
        if (value) await setSetting(key, value); else await delSetting(key);
        return {};
      }
      if (key === 'secretary_info') {
        if (value) await setSetting(key, value); else await delSetting(key);
        return {};
      }
      throw bad(`"${key}" cannot be changed from the panel`);
  }
}

async function connectionCount() {
  try {
    return JSON.parse(await getSetting('secretary_conns', '[]')).length;
  } catch {
    return 0;
  }
}

// --- probe -------------------------------------------------------------------------
// A probe is eight generations. On a slow CPU that is minutes, far too long to hold
// an HTTP request open, so the panel starts it and polls for the result.
const probeRun = { running: false, startedAt: 0, done: 0, total: 8, error: null, result: null };

async function startProbe() {
  if (probeRun.running) throw conflict('A probe is already running.');
  probeRun.running = true;
  probeRun.startedAt = Date.now();
  probeRun.done = 0;
  probeRun.error = null;
  probeRun.result = null;
  log('info', 'probe started from the panel');

  (async () => {
    try {
      const summary = await runProbe({
        ownerName: await ownerName(),
        lang: await getSetting('lang', 'en'),
        onProgress: (done) => { probeRun.done = done; },
      });
      const { modelSettings: ms } = await import('../../tgcloud/lib/brain.js');
      const model = (await ms()).model;
      await saveProbe(summary, model);
      probeRun.result = summary;
      await logActivity('info', `Panel: probe finished ${summary.scoreFinal}/${summary.total}`);
      log('info', `probe finished ${summary.scoreFinal}/${summary.total}`);
    } catch (e) {
      probeRun.error = e?.message ?? String(e);
      log('error', `probe failed: ${probeRun.error}`);
    } finally {
      probeRun.running = false;
    }
  })();
}

// --- state -------------------------------------------------------------------------
async function buildState() {
  const ms = await modelSettings();
  const contacts = await listContacts(200).catch(() => []);
  const metrics = await metricsSummary(20).catch(() => null);
  const llm = await cachedHealth({ baseUrl: ms.baseUrl, apiKey: ms.apiKey });
  const mem = readMem();
  const draftCount = await countPendingDrafts().catch(() => 0);

  return {
    // Read, never hand-maintained: the panel used to announce 1.1.1 while the
    // package said something else.
    version: readVersion(path.join(HERE, '..', '..')) || '',
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
    // The public address only. The tokenised URL stays on this machine so that a
    // screenshot of this page cannot hand over the panel.
    panel: {
      available: runtime.panelAvailable !== false,
      url: runtime.panelUrlPublic || '',
      tokenFile: tokenFile(),
      hasToken: Boolean(ACCESS_TOKEN),
      fixedToken: Boolean(process.env.PANEL_TOKEN),
    },
    model: { provider: ms.provider, baseUrl: ms.baseUrl, name: ms.model },
    machine: machine(),
    llm,
    queue: { ...llmQueue },
    system: {
      loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      cpus: os.cpus().length,
      mem,
      temps: readTemps(),
    },
    state: { ...stats(), lock: lockInfo() },
    connections: await connectionCount(),
    contacts,
    metrics,
    probe: {
      verdict: await probeVerdict(),
      last: await lastProbe(),
      run: probeRun,
    },
    quiet: {
      start: await getSetting('quiet_start', ''),
      end: await getSetting('quiet_end', ''),
      activeNow: inQuietHours({
        start: await getSetting('quiet_start', ''),
        end: await getSetting('quiet_end', ''),
        tz: await getSetting('timezone', TIMEZONE),
      }),
    },
    draftsPending: draftCount,
    languages: LANGUAGES,
    settings: await readSettings(),
    secrets: {
      botToken: Boolean(process.env.BOT_TOKEN),
      apiKey: Boolean(ms.apiKey),
    },
  };
}

// --- api ---------------------------------------------------------------------------
async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const isWrite = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
  // Signing in and out are authorised by the token in the body, not by the origin:
  // a hostile page cannot guess the token (and guesses are throttled), so an origin
  // check there only ever locks out a legitimate proxy. Every other write keeps it.
  if (isWrite && !SESSION_ROUTES.has(route)) checkOrigin(req);
  const body = isWrite ? await readBody(req) : {};

  if (route === 'GET /api/ping') {
    // Unauthenticated on purpose: the page needs to know whether to show a login
    // form before it has a token. In demo mode it also gets the token it needs.
    return json(res, 200, {
      ok: true,
      needsAuth: Boolean(ACCESS_TOKEN) && !authed(req, url),
      version: '1.2.0',
      demo: DEMO,
      demoToken: DEMO ? ACCESS_TOKEN : undefined,
    });
  }

  if (route === 'POST /api/login') {
    const ip = ipOf(req);
    const blockedFor = loginBlocked(ip);
    if (blockedFor > 0) {
      return json(res, 429, { error: `Too many wrong tokens. Try again in ${Math.ceil(blockedFor / 1000)} s.` });
    }
    // The token may arrive in the body or as a bearer header. The page sends both:
    // a proxy can drop a request body, and "the right token is rejected" is an
    // impossible-looking bug to chase from the outside.
    const inBody = typeof body?.token === 'string' ? body.token : '';
    const inHeader = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    // Either one may be the intact copy; a proxy that rewrites the body should not
    // be able to veto a correct header, and vice versa.
    const given = inBody || inHeader;

    if (!ACCESS_TOKEN || sameSecret(inBody, ACCESS_TOKEN) || sameSecret(inHeader, ACCESS_TOKEN)) {
      loginFails.delete(ip);
      res.setHeader('Set-Cookie', `panel_token=${encodeURIComponent(ACCESS_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
      // Also hand the token back so the page can keep it and send it as a bearer
      // header. Some proxies strip Set-Cookie, and without this the cookie-less
      // client would be anonymous again on the very next request — which looks
      // exactly like "the right token is rejected". The caller just proved it
      // knows the token, so returning it discloses nothing new.
      return json(res, 200, ACCESS_TOKEN ? { ok: true, token: ACCESS_TOKEN } : { ok: true });
    }
    noteLoginFailure(ip);
    const why = describeBadToken(given, inBody, inHeader);
    log('warn', `panel: wrong token from ${ip} —${why}`);
    return json(res, 401, {
      error: `Wrong token${why}. It is printed when the bot starts, and stored in the panel token file.`,
    });
  }

  if (route === 'POST /api/logout') {
    res.setHeader('Set-Cookie', 'panel_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  if (!authed(req, url)) return json(res, 401, { error: 'Unauthorised' });

  if (route === 'GET /api/state') return json(res, 200, await buildState());

  if (route === 'GET /api/settings') {
    return json(res, 200, { settings: await readSettings(), languages: LANGUAGES });
  }

  if (route === 'POST /api/settings') {
    const entries = Object.entries(body.settings ?? (body.key ? { [body.key]: body.value } : {}));
    if (!entries.length) throw bad('No settings in the request');

    // Validate all of them before writing any of them.
    const validated = entries.map(([key, value]) => [key, validateSetting(key, value)]);

    const results = {};
    for (const [key, value] of validated) {
      results[key] = await applySetting(key, value, { force: Boolean(body.force) });
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
    if (text.length > 10000) throw bad('The limit is 10 000 characters');
    if (text.trim()) await setSetting(`prompt_${mode}`, text.trim());
    else await delSetting(`prompt_${mode}`);
    await logActivity('info', `Panel: ${mode} prompt ${text.trim() ? 'updated' : 'reset'}`);
    return json(res, 200, { ok: true });
  }

  if (route === 'GET /api/notes') {
    return json(res, 200, { notes: await db.select().from(notes).orderBy(asc(notes.id)).all() });
  }
  if (route === 'POST /api/notes') {
    const text = String(body.text ?? '').trim();
    if (!text) throw bad('Empty note');
    if (text.length > 2000) throw bad('Keep a note under 2000 characters');
    const [row] = await db.insert(notes).values({ text, created: Math.floor(Date.now() / 1000) }).returning().run();
    return json(res, 200, { ok: true, note: row });
  }
  if (req.method === 'DELETE' && /^\/api\/notes\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/').pop());
    const existing = await db.select().from(notes).where(eq(notes.id, id)).get();
    if (!existing) throw gone('That note no longer exists.');
    await db.delete(notes).where(eq(notes.id, id)).run();
    return json(res, 200, { ok: true });
  }

  if (route === 'GET /api/drafts') {
    const status = url.searchParams.get('status') || 'pending';
    if (!['pending', 'sent', 'ignored', 'all'].includes(status)) throw bad('status must be pending, sent, ignored or all');
    return json(res, 200, { drafts: await listDrafts({ status, limit: 50 }) });
  }

  const draftAction = /^\/api\/drafts\/(\d+)\/(send|ignore|regen)$/.exec(url.pathname);
  if (req.method === 'POST' && draftAction) {
    const id = Number(draftAction[1]);
    const action = draftAction[2];
    const draft = await getDraft(id);
    if (!draft) throw gone('That draft no longer exists.');
    if (draft.status !== 'pending') throw conflict(`This draft was already ${draft.status}.`);

    try {
      if (action === 'send') return json(res, 200, { ok: true, draft: await sendDraft(id, { text: body.text }) });
      if (action === 'ignore') return json(res, 200, { ok: true, draft: await ignoreDraft(id) });
      return json(res, 200, { ok: true, draft: await regenerateDraft(id) });
    } catch (e) {
      // "already sent", an empty draft, Telegram refusing or unreachable…
      if (/already/i.test(e.message)) throw conflict(e.message);
      throw telegramFailure(e);
    }
  }

  if (req.method === 'PUT' && /^\/api\/drafts\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/').pop());
    const draft = await getDraft(id);
    if (!draft) throw gone('That draft no longer exists.');
    // A sent draft is a record of what a real person received. Editing it would
    // quietly rewrite history, so only pending drafts are editable.
    if (draft.status !== 'pending') throw conflict(`This draft was already ${draft.status} — it cannot be edited.`);
    const text = String(body.text ?? '').trim();
    if (!text) throw bad('Empty draft');
    if (text.length > 4000) throw bad('Keep the draft under 4000 characters');
    try {
      const updated = await updateDraftText(id, text);
      await logActivity('info', `Panel: draft for ${draft.name} edited`);
      return json(res, 200, { ok: true, draft: updated });
    } catch (e) {
      throw bad(e.message);
    }
  }

  if (route === 'GET /api/contacts') {
    const contacts = await listContacts(200);
    // Learned facts ride along: the People tab shows what the bot picked up, so
    // the owner can delete a wrong one without leaving the page.
    const withFacts = await Promise.all(contacts.map(async (c) => ({
      ...c,
      facts: await listFacts(c.chatId).catch(() => []),
    })));
    return json(res, 200, { contacts: withFacts, factLimit: FACT_LIMIT });
  }
  if (req.method === 'POST' && /^\/api\/contacts\/\d+$/.test(url.pathname)) {
    const chatId = Number(url.pathname.split('/').pop());
    const patch = {};
    if ('notes' in body) patch.notes = String(body.notes ?? '');
    if ('lang' in body) patch.lang = String(body.lang ?? '');
    if ('blocked' in body) patch.blocked = Boolean(body.blocked);
    if (!Object.keys(patch).length) throw bad('Nothing to update.');
    if (patch.notes && patch.notes.length > NOTES_LIMIT) throw bad(`Keep the notes under ${NOTES_LIMIT} characters.`);
    if (patch.lang && !isLanguage(patch.lang)) throw bad('Unknown language code (or "auto").');
    try {
      return json(res, 200, { ok: true, contact: await updateContact(chatId, patch) });
    } catch (e) {
      throw bad(e.message);
    }
  }

  // Learned facts: delete one, pin it (pinned facts survive the size cap), or
  // clear a person's whole list.
  if (req.method === 'POST' && /^\/api\/facts\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/').pop());
    if (!('pinned' in body)) throw bad('Send { "pinned": true } or delete the fact.');
    try {
      await setPinned(id, Boolean(body.pinned));
      return json(res, 200, { ok: true });
    } catch (e) {
      throw gone(e.message);
    }
  }
  if (req.method === 'DELETE' && /^\/api\/facts\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/').pop());
    const removed = await deleteFact(id);
    if (!removed) throw gone('No such fact.');
    return json(res, 200, { ok: true });
  }
  if (req.method === 'DELETE' && /^\/api\/contacts\/\d+\/facts$/.test(url.pathname)) {
    const chatId = Number(url.pathname.split('/')[3]);
    await clearFacts(chatId);
    return json(res, 200, { ok: true });
  }

  if (route === 'GET /api/update') {
    const updater = runtime.updater;
    if (!updater) throw bad('The updater is not running in this process.');
    const state = await updater.status();
    const mode = await getSetting('update_mode', 'notify');
    return json(res, 200, {
      state,
      summary: describeStatus(state),
      mode,
      autoCheck: (await getSetting('update_check', 'on')) !== 'off',
      branch: await getSetting('update_branch', ''),
      lastCheck: updater.lastCheck,
      lastApply: updater.lastApply,
      verdict: decide(mode, state),
    });
  }

  if (route === 'POST /api/update') {
    const updater = runtime.updater;
    if (!updater) throw bad('The updater is not running in this process.');
    const action = String(body.action || 'check');

    if (action === 'check') {
      const state = await updater.check();
      log('info', `update check from the panel: ${describeStatus(state)}`);
      return json(res, 200, { ok: true, state, summary: describeStatus(state) });
    }

    if (action === 'apply') {
      let result;
      try {
        result = await updater.apply();
      } catch (e) {
        throw bad(e.message);
      }
      log('info', `update applied from the panel: ${result.message}`);
      if (result.updated) {
        // Answer the request first: the process exits a moment later.
        setTimeout(() => runtime.onRestart?.('update installed from the panel'), 2000);
      }
      return json(res, 200, {
        ok: true,
        ...result,
        restarting: result.updated,
        note: result.updated
          ? 'Installed. The bot is restarting to run the new code.'
          : 'Nothing to install.',
      });
    }

    if (action === 'rollback') {
      let result;
      try {
        result = await updater.rollback(body.to);
      } catch (e) {
        throw bad(e.message);
      }
      log('warn', `rollback from the panel: ${result.message}`);
      setTimeout(() => runtime.onRestart?.('rollback'), 2000);
      return json(res, 200, { ok: true, ...result, restarting: true });
    }

    throw bad('Unknown action. Use check, apply or rollback.');
  }

  if (route === 'GET /api/metrics') {
    return json(res, 200, { summary: await metricsSummary(20), recent: await recentMetrics(40) });
  }

  if (route === 'GET /api/probe') {
    return json(res, 200, { run: probeRun, verdict: await probeVerdict(), last: await lastProbe() });
  }
  if (route === 'POST /api/probe') {
    await startProbe();
    return json(res, 200, { started: true, run: probeRun });
  }

  if (route === 'GET /api/activity') return json(res, 200, { activity: await recentActivity(80) });
  if (route === 'GET /api/log') return json(res, 200, { log: runtime.log.slice(-120).reverse() });

  if (route === 'POST /api/test-model') {
    const text = String(body.text ?? '').slice(0, 500) || 'Hello! In one short sentence, say what you are.';
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
    if (!owner) throw bad('No owner set yet — send /claim to the bot, or set the owner id in Setup.');
    const { api } = await import('../sdk/telegram.mjs');
    try {
      await api.sendMessage({ chat_id: owner, text: '✅ Test message from the control panel. The bot can reach Telegram.' });
    } catch (e) {
      throw gateway(`Telegram refused the message: ${e?.description ?? e?.message ?? e}`);
    }
    return json(res, 200, { ok: true });
  }

  throw gone(`Unknown endpoint ${route}`);
}

// --- server ------------------------------------------------------------------------
export async function startPanel({ port = 8787, host = '0.0.0.0', lanAddress = '127.0.0.1', demo } = {}) {
  // `demo: true` forces demo behaviour (self sign-in) for tests and for anyone who
  // wants to show the panel against sample data without setting the state dir.
  if (demo !== undefined) DEMO = Boolean(demo);
  ensureToken();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Demo instances write one line per request. If a panel ever "does nothing"
    // again, this says whether the browser asked for the page, the script or an
    // API route — and whether a login POST even arrived.
    if (DEMO) {
      const who = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?';
      log('info', `panel: ${req.method} ${url.pathname} from ${who}`);
    }

    if (url.pathname.startsWith('/api/')) {
      maybeSetCookie(url, res);
      handleApi(req, res, url).catch((e) => {
        const status = e instanceof HttpError ? e.status : 500;
        if (!res.headersSent) json(res, status, { error: e?.message ?? String(e) });
        if (status >= 500) log('error', `panel: ${e?.message ?? e}`);
      });
      return;
    }

    if (url.pathname === '/healthz') return json(res, 200, { ok: true });

    const asset = ASSETS[url.pathname];
    if (!asset) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');

    maybeSetCookie(url, res);
    fs.readFile(path.join(HERE, asset.file), (err, data) => {
      if (err) {
        log('error', `panel: cannot read ${asset.file}`);
        return send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, `${asset.file} is missing next to panel/server.mjs`);
      }
      // No caching: an updated ui.js that the browser refuses to re-fetch is a
      // support problem that looks like a bug in the panel.
      send(res, 200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' }, data);
    });
  });

  await new Promise((resolve) => {
    server.once('error', (e) => {
      runtime.panelAvailable = false;
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
      runtime.panelAvailable = true;
      runtime.panelUrlPublic = `http://${lanAddress}:${actual}`;
      // The tokenised URL is for this machine only — never for the page or the database.
      runtime.panelUrl = `${runtime.panelUrlPublic}/?token=${ACCESS_TOKEN}`;
      log('info', `control panel on ${runtime.panelUrlPublic}  (token: ${process.env.PANEL_TOKEN ? 'PANEL_TOKEN' : tokenFile()})`);
      resolve();
    });
  });

  return server;
}

export { ensureToken, validateSetting };
