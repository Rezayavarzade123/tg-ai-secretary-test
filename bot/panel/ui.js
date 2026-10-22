/* Secretary control panel — single page, no dependencies. */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  tab: 'dashboard',
  state: null,
  prompts: null,
  notes: [],
  drafts: [],
  draftStatus: 'pending',
  activity: [],
  log: [],
  contacts: [],
  test: null,        // result of "try the model", kept across refreshes
  dirty: false,      // an unsaved edit is on screen: do not re-render under the user
};

const TITLES = {
  dashboard: 'Dashboard', secretary: 'Secretary mode', drafts: 'Drafts', people: 'People',
  prompts: 'Prompts', notes: 'Notes', activity: 'Activity', setup: 'Setup',
};

// --- session -------------------------------------------------------------------
// The session is deliberately kept twice: in the HttpOnly cookie the server sets,
// and in sessionStorage, which this script sends as a bearer header. Some setups
// drop cookies — a reverse proxy that strips Set-Cookie, a browser with cookies
// blocked, a preview frame on another origin — and there a correct token looks
// wrong, forever, because every request after the login is anonymous again. The
// header path cannot be dropped by anyone in the middle.
const TOKEN_KEY = 'secretary.panel.token';

// The in-memory copy is the one that always exists. sessionStorage is only there so
// a reload does not ask again; in a sandboxed frame it throws on access, and there
// the cookie may be refused as well — the variable still carries the session.
let memToken = '';

function savedToken() {
  if (memToken) return memToken;
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function saveToken(token) {
  memToken = token || '';
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* no storage available: the variable above is enough for this tab */ }
}

// --- networking ---------------------------------------------------------------
async function api(path, options = {}) {
  const { headers, ...rest } = options;
  const token = savedToken();
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
  let body = null;
  try { body = await res.json(); } catch { body = {}; }
  if (res.status === 401) {
    // The login route reports "wrong token" itself; everything else means the
    // session is gone, so drop the stale copy, say so on the login screen, and ask
    // again. Silently showing the box again is what made a dead session look like
    // a rejected password.
    if (path !== '/api/login') {
      saveToken('');
      const err = $('#loginErr');
      if (err) err.textContent = `Session expired — ${body?.error || 'sign in again'}`;
      showLogin(true);
    }
    throw new Error(body?.error || 'Unauthorised — enter the panel token.');
  }
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, isError ? 6000 : 3000);
}

function showLogin(show) {
  $('#login').classList.toggle('show', show);
  if (show) setTimeout(() => $('#tokenInput').focus(), 50);
}

// --- loading ------------------------------------------------------------------
async function refresh({ quiet = true } = {}) {
  try {
    S.state = await api('/api/state');
    if (S.tab === 'drafts') S.drafts = (await api(`/api/drafts?status=${encodeURIComponent(S.draftStatus)}`)).drafts;
    if (S.tab === 'notes') S.notes = (await api('/api/notes')).notes;
    if (S.tab === 'people') S.contacts = (await api('/api/contacts')).contacts;
    if (S.tab === 'prompts') S.prompts = await api('/api/prompts');
    if (S.tab === 'activity') {
      S.activity = (await api('/api/activity')).activity;
      S.log = (await api('/api/log')).log;
    }
    renderChrome();
    render();
  } catch (e) {
    if (!quiet) toast(e.message, true);
    else console.warn(e);
  }
}

function renderChrome() {
  const st = S.state;
  if (!st) return;
  const bot = st.bot ? `@${st.bot.username}` : 'no bot';
  $('#brandSub').textContent = bot;
  $('#footBot').textContent = bot;
  $('#footUptime').textContent = `up ${fmtDuration(st.uptime)} · ${st.platform}`;
  $('#pageTitle').textContent = TITLES[S.tab] || S.tab;

  $('#pillBot').innerHTML = `<span class="dot ${st.bot ? 'ok' : 'bad'}"></span> <span>${esc(bot)}</span>`;

  const llmOk = st.llm && st.llm.ok;
  $('#pillModel').innerHTML = `<span class="dot ${llmOk ? 'ok' : 'bad'}"></span> <span>${esc(
    (st.model.provider === 'cloud' ? 'cloud' : st.model.name) + (llmOk ? ` · ${st.llm.ms} ms` : ' · offline'),
  )}</span>`;

  $('#pillPoll').innerHTML = `<span class="dot ${st.polling ? 'ok' : 'warn'}"></span> <span>${st.polling ? 'polling' : 'idle'} · ${st.draftsPending || 0} draft${st.draftsPending === 1 ? '' : 's'}</span>`;

  const badge = $('#navDrafts');
  badge.hidden = !st.draftsPending;
  badge.textContent = st.draftsPending || 0;
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// --- rendering ------------------------------------------------------------------
function render() {
  const view = $('#view');
  if (!S.state) { view.innerHTML = '<p class="muted">Connecting…</p>'; return; }

  const views = {
    dashboard: viewDashboard, secretary: viewSecretary, drafts: viewDrafts, people: viewPeople,
    prompts: viewPrompts, notes: viewNotes, activity: viewActivity, setup: viewSetup,
  };
  const y = window.scrollY;
  view.innerHTML = (views[S.tab] || viewDashboard)();
  wire();
  window.scrollTo(0, y);
  S.dirty = false;
}

// The machine card. Deliberately plain: what the CPU is, whether it has AVX2,
// how much memory, and which model that implies — the same four facts the CLI
// prints, so the panel and `npm run hw` cannot disagree.
function machineCard(m) {
  if (!m) return '<p class="muted">Not read yet.</p>';
  const simd = Object.entries(m.vec || {}).filter(([, on]) => on).map(([k]) => k.toUpperCase());
  const ram = `${(m.memMb / 1024).toFixed(1)} GB`;
  return `
    <div class="grid cols-2">
      ${stat('CPU', `${m.cpu.cores} cores`, true)}
      ${stat('Memory', ram, true)}
      ${stat('AVX2', m.vec.avx2 ? 'yes' : 'no', true, m.vec.avx2 ? 'ok' : 'warn')}
      ${stat('Threads', String(m.threads), true)}
    </div>
    <p class="small muted" style="margin:10px 0 0">${esc(m.cpu.modelName || 'unknown CPU')} · ${esc(simd.join(' ') || 'no SIMD detected')} · ${esc(m.kernel || '')}</p>
    <p class="small" style="margin:6px 0 0">Suggested brain: <strong>${esc(m.model.name)} ${esc(m.model.quant)}</strong>, <code>-c ${m.model.ctx} -t ${m.threads}</code></p>
    ${m.warnings && m.warnings.length
      ? `<div class="banner info" style="margin-top:10px">${m.warnings.map((w) => esc(w)).join('<br>')}</div>`
      : ''}`;
}

function viewLatency() {
  const st = S.state;
  const m = st.metrics;
  const run = (st.probe && st.probe.run) || {};
  const verdict = (st.probe && st.probe.verdict) || {};
  const last = m && m.last;
  return `
  <div class="grid cols-2" style="margin-top:14px">
    <div class="card">
      <h2>Speed</h2>
      <p class="hint">Measured on this machine, from the server's own timings. Prefill is usually the number that hurts.</p>
      ${m && m.count ? `
      <div class="grid cols-3">
        ${stat('Last reply', last ? `${(last.totalMs / 1000).toFixed(1)} s` : '—', true)}
        ${stat('Generated', last ? `${last.completionTokens} tok` : '—', true)}
        ${stat('Prompt', last ? `${last.promptTokens} tok` : '—', true)}
        ${stat('Out speed', m.decodeTps ? `${m.decodeTps} tok/s` : 'n/a', true, m.decodeTps && m.decodeTps < 5 ? 'warn' : '')}
        ${stat('Prefill', m.prefillTps ? `${m.prefillTps} tok/s` : 'n/a', true, m.prefillTps && m.prefillTps < 10 ? 'warn' : '')}
        ${stat('Average', `${m.avgTotalMs} ms`, true)}
      </div>
      <p class="hint small" style="margin:10px 0 0">Averaged over the last ${m.count} replies${m.timedCalls ? '' : ' (this server reports no timings, so no tok/s)'}.</p>
      ` : '<p class="muted">No replies yet. Run the model test above, or send the bot a message.</p>'}
    </div>

    <div class="card">
      <h2>This machine</h2>
      <p class="hint">Read from the CPU and memory it is running on. Nothing here is console-specific: the same panel makes the same decision on a laptop or a mini-PC with the same flags.</p>
      ${machineCard(st.machine)}
    </div>

    <div class="card">
      <h2>Auto-mode gate</h2>
      <p class="hint">Auto mode answers people without you. It stays locked until a probe shows the guarded replies are safe.</p>
      <div class="row" style="margin-bottom:10px">
        <span class="tag ${verdict.ok ? 'ok' : 'warn'}">${verdict.ok ? 'open' : 'locked'}</span>
        <span class="small muted">${esc(verdict.reason || 'no probe yet')}</span>
      </div>
      ${run.running
        ? `<div class="banner info">Probing… ${run.done}/${run.total}</div>`
        : run.error ? `<div class="banner bad">${esc(run.error)}</div>` : ''}
      <div class="row">
        <button type="button" id="probeBtn" ${run.running ? 'disabled' : ''}>${run.running ? 'Running…' : 'Run probe'}</button>
        <span class="small muted">8 awkward messages, minutes on a slow CPU</span>
      </div>
      ${run.result ? `<div class="banner ${run.result.scoreFinal >= 7 ? 'ok' : ''}" style="margin:10px 0 0">
        Scored ${run.result.scoreFinal}/${run.result.total} on the text that would actually be sent
        (the model alone: ${run.result.scoreRaw}/${run.result.total}).</div>` : ''}
    </div>
  </div>`;
}

function stat(k, v, small = false, kind = '') {
  const color = kind === 'ok' ? 'var(--ok)' : kind === 'bad' ? 'var(--bad)' : kind === 'warn' ? 'var(--warn)' : 'inherit';
  return `<div class="stat"><div class="k">${esc(k)}</div>` +
    `<div class="v${small ? ' small-v' : ''}" style="color:${color}">${esc(v)}</div></div>`;
}

// A real button with the role of a switch: reachable with Tab, toggled with Enter/Space.
function toggle(id, on, label) {
  return `<button type="button" class="sw" id="${id}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${esc(label)}"></button>`;
}

function viewDashboard() {
  const st = S.state;
  const llm = st.llm || {};
  const mem = st.system.mem;
  const memPct = mem.total ? Math.round((mem.used / mem.total) * 100) : 0;
  const hottest = st.system.temps && st.system.temps[0];
  const warnings = [];
  if (!st.bot) warnings.push('The bot is not connected to Telegram. Check the token in Setup.');
  if (!st.owner.id) warnings.push('No owner set. Send <code>/claim</code> to the bot in Telegram (or set the owner id in Setup).');
  if (!llm.ok) warnings.push(`The model server is offline${llm.error ? `: ${esc(llm.error)}` : ''}. Start llama-server, or change its address in Setup.`);
  if (st.panel && st.panel.available === false) warnings.push('The panel could not bind its port, so this page is being served by a stale process.');
  if (st.state.externalChange) {
    warnings.push(`<code>bot.json</code> was changed on disk ${fmtAgo(st.state.externalChange.at)} — another process may be running on the same state directory. Two writers overwrite each other.`);
  }

  const test = S.test;
  return `
  ${warnings.map((w) => `<div class="banner bad">${w}</div>`).join('')}
  <div class="grid cols-3">
    ${stat('Model', st.model.name || '—', true)}
    ${stat('Brain', st.model.provider === 'cloud' ? 'Ollama cloud' : 'local', true)}
    ${stat('Server', llm.ok ? `online · ${llm.ms} ms` : 'offline', true, llm.ok ? 'ok' : 'bad')}
    ${stat('Queue', st.queue.active ? 'generating' : 'idle', true, st.queue.active ? 'warn' : 'ok')}
    ${stat('Drafts waiting', String(st.draftsPending || 0), false, st.draftsPending ? 'warn' : '')}
    ${stat('Uptime', fmtDuration(st.uptime))}
    ${stat('Memory', `${memPct}% used`, true, memPct > 88 ? 'bad' : '')}
    ${stat('Load (1m)', String(st.system.loadavg[0]), true, st.system.loadavg[0] > st.system.cpus ? 'warn' : '')}
    ${stat(hottest ? 'Hottest sensor' : 'Temperature', hottest ? `${hottest.celsius} °C · ${hottest.sensor}` : 'n/a', true, hottest && hottest.celsius > 80 ? 'bad' : '')}
  </div>

  <div class="grid cols-2" style="margin-top:14px">
    <div class="card">
      <h2>Try the model</h2>
      <p class="hint">Sends a message through the same prompt the bot uses. The honest test of whether this machine is keeping up.</p>
      <div class="field">
        <textarea id="testText" rows="2">${esc(test ? test.prompt : 'Hello! In one short sentence, introduce yourself.')}</textarea>
      </div>
      <div class="row">
        <button type="button" class="primary" id="testBtn">Run test</button>
        <span class="small" id="testOut">${test ? (test.ok
          ? `<span style="color:var(--ok)">${esc((test.ms / 1000).toFixed(1))} s</span> · ${esc(test.answer.slice(0, 300))}`
          : `<span style="color:var(--bad)">${esc(test.error)}</span>`) : '<span class="muted">not run yet</span>'}</span>
      </div>
    </div>

    <div class="card">
      <h2>What is happening</h2>
      <p class="hint">Live counters since the bot started.</p>
      <div class="split">
        <div>
          <h3>Messages from you</h3>
          <div class="mono">${st.counts.message || 0} received</div>
          <h3 style="margin-top:12px">Secretary chats</h3>
          <div class="mono">${st.counts.business_message || 0} received</div>
        </div>
        <div>
          <h3>Button presses</h3>
          <div class="mono">${st.counts.callback_query || 0} handled</div>
          <h3 style="margin-top:12px">Last update</h3>
          <div class="mono">${fmtAgo(st.lastUpdateAt)}</div>
        </div>
      </div>
      ${st.lastError ? `<div class="banner bad" style="margin:14px 0 0"><strong>Last error</strong> (${fmtAgo(st.lastErrorAt)})<br>${esc(st.lastError)}</div>` : ''}
    </div>
  </div>

  ${viewLatency()}

  <div class="card" style="margin-top:14px">
    <h2>Machine</h2>
    <p class="hint">${esc(st.platform)} · node ${esc(st.node)} · pid ${st.pid} · state file <code>${esc(st.state.file)}</code></p>
    <div class="grid cols-3">
      ${stat('RAM', `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}`, true)}
      ${stat('CPUs', String(st.system.cpus), true)}
      ${stat('Load (5m / 15m)', st.system.loadavg.slice(1).join(' / '), true)}
      ${stat('State size', fmtBytes(st.state.bytes), true)}
      ${stat('Settings rows', String(st.state.counts.settings || 0), true)}
      ${stat('History rows', String(st.state.counts.history || 0), true)}
    </div>
    <div class="row end" style="margin-top:12px">
      <button type="button" id="backupBtn">Back up the database</button>
    </div>
  </div>`;
}

function viewSecretary() {
  const st = S.state;
  const s = st.settings || {};
  const mode = s.secretary_mode || 'draft';
  const lang = st.languages.find((l) => l.code === (s.lang || 'en')) || st.languages[0];
  const auto = (s.lang_auto || 'on') !== 'off';
  const delay = Number(s.delay_seconds ?? 50);
  const pause = Number(s.pause_hours ?? 4);
  const notify = (s.notify || 'on') !== 'off';
  const conns = st.connections ?? 0;

  return `
  ${st.bot && !conns ? '<div class="banner info">Not connected to an account yet. On your phone: <strong>Settings → Account → Chat Automation</strong>, pick this bot, and allow it to reply.</div>' : ''}

  <div class="grid cols-2">
    <div class="card">
      <h2>How replies are sent</h2>
      <p class="hint">With a 1–2B model, drafts are the safe default: you see every reply before a real person does.</p>
      <div class="seg" id="modeSeg" role="group" aria-label="Reply mode">
        <button type="button" data-mode="draft" class="${mode === 'draft' ? 'on' : ''}" aria-pressed="${mode === 'draft'}">📝 Draft</button>
        <button type="button" data-mode="auto" class="${mode === 'auto' ? 'on' : ''}" aria-pressed="${mode === 'auto'}">⚡ Auto</button>
        <button type="button" data-mode="off" class="${mode === 'off' ? 'on' : ''}" aria-pressed="${mode === 'off'}">⏸ Off</button>
      </div>
      <p class="hint" style="margin-top:12px">
        <strong>Draft</strong> — the bot shows you a card in Telegram, you press Send.<br>
        <strong>Auto</strong> — it answers by itself, after the safety net in <code>lib/guard.js</code>.<br>
        <strong>Off</strong> — it never answers anyone on your account.
      </p>
      <div class="row" style="margin-top:6px">
        <span class="tag ${conns ? 'ok' : 'warn'}">${conns ? `${conns} connection${conns === 1 ? '' : 's'}` : 'no connection'}</span>
        <span class="tag">owner ${st.owner.id || '—'}</span>
      </div>
    </div>

    <div class="card">
      <h2>Language</h2>
      <p class="hint">A small model drifts between languages. Fixing the reply language makes it much more predictable.</p>
      <div class="field">
        <label for="langSel">Reply language</label>
        <select id="langSel">
          ${st.languages.map((l) => `<option value="${l.code}"${l.code === lang.code ? ' selected' : ''}>${esc(`${l.native} — ${l.label} (${l.code})`)}</option>`).join('')}
        </select>
      </div>
      <div class="row" style="justify-content:space-between;margin-bottom:4px">
        <div>
          <div>Follow the person's language</div>
          <div class="small muted">On: reply in whatever language they write. Off: always use the language above.</div>
        </div>
        ${toggle('langAuto', auto, 'Follow the person’s language')}
      </div>
      <p class="hint small" style="margin-top:12px">Same setting as Telegram: <code>/lang fa</code>, <code>/lang auto off</code>.</p>
    </div>
  </div>

  <div class="grid cols-2" style="margin-top:14px">
    <div class="card">
      <h2>Timing</h2>
      <p class="hint">"Breathing time": wait after a person's last message so several fragments get one answer.</p>
      <div class="field">
        <label for="delayRange">Reply delay — <span id="delayVal">${delay}</span> s</label>
        <input id="delayRange" type="range" min="0" max="300" step="5" value="${delay}" aria-label="Reply delay in seconds">
      </div>
      <div class="field">
        <label for="pauseHours">Stay quiet after you reply yourself (hours)</label>
        <input id="pauseHours" type="number" min="0" max="168" value="${pause}">
      </div>
      <div class="row" style="justify-content:space-between;margin-bottom:12px">
        <div>
          <div>Copy replies to me</div>
          <div class="small muted">Every reply, plus what the safety net replaced.</div>
        </div>
        ${toggle('notifySw', notify, 'Copy secretary replies to me')}
      </div>
      <hr style="border:0;border-top:1px solid var(--line);margin:12px 0">
      <div class="row" style="justify-content:space-between;margin-bottom:6px">
        <div>
          <div>Quiet hours</div>
          <div class="small muted">In this window, auto mode prepares a draft instead of replying. ${st.quiet?.activeNow ? '<strong style="color:var(--warn)">Active now.</strong>' : ''}</div>
        </div>
        <span class="tag">${esc(quietLabel(st.quiet))}</span>
      </div>
      <div class="row">
        <div class="grow">
          <label for="quietStart">From (hour)</label>
          <input id="quietStart" type="number" min="0" max="23" value="${esc(st.quiet?.start ?? '')}" placeholder="off">
        </div>
        <div class="grow">
          <label for="quietEnd">To (hour)</label>
          <input id="quietEnd" type="number" min="0" max="23" value="${esc(st.quiet?.end ?? '')}" placeholder="off">
        </div>
        <button type="button" class="primary" id="saveQuiet" style="align-self:flex-end">Save</button>
      </div>
    </div>

    <div class="card">
      <h2>What the secretary may say</h2>
      <p class="hint">The only information it is allowed to share about you (hours, how to reach you, when you are back).</p>
      <div class="field">
        <textarea id="secretaryInfo" rows="6" dir="auto" placeholder="e.g. I'm travelling until Friday. For urgent things call my office. Replies may take a day.">${esc(s.secretary_info || '')}</textarea>
      </div>
      <div class="row end">
        <button type="button" class="primary" id="saveInfoBtn">Save</button>
      </div>
    </div>
  </div>`;
}

function quietLabel(q) {
  if (!q || q.start === '' || q.end === '') return 'off';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(q.start)}:00–${pad(q.end)}:00`;
}

// People: one row per chat that has written to the account. A couple of lines of
// context here does more for reply quality than a bigger model.
function viewPeople() {
  const st = S.state;
  const list = S.contacts || [];
  return `
  <div class="card" style="margin-bottom:14px">
    <h2>People</h2>
    <p class="hint">Everyone who has written to your account. <strong>Context</strong> is added to the prompt for that chat only — tell it who they are. <strong>Language</strong> overrides the global setting for one person. <strong>Blocked</strong> means the bot ignores them entirely.</p>
    ${list.length === 0 ? '<p class="muted">Nobody yet. When someone messages your account, they show up here.</p>' : ''}
  </div>
  ${list.map((c) => `
    <div class="item" data-contact="${c.chatId}">
      <div class="meta">
        <strong style="color:var(--text)">${esc(c.name || 'Unknown')}</strong>
        <span>chat ${esc(c.chatId)}</span>
        ${c.blocked ? '<span class="tag bad">blocked</span>' : ''}
        ${c.muted ? '<span class="tag warn">muted</span>' : ''}
        ${c.lang ? `<span class="tag">lang ${esc(c.lang)}</span>` : ''}
        <span style="margin-left:auto">${c.lastSeenAt ? `seen ${fmtAgo(c.lastSeenAt * 1000)}` : 'not seen yet'}</span>
      </div>
      <div class="row" style="align-items:flex-start">
        <div class="grow">
          <label for="notes-${c.chatId}">Context (max 400 characters)</label>
          <textarea id="notes-${c.chatId}" rows="2" dir="auto" placeholder="e.g. Sara is my sister, she knows about the trip">${esc(c.notes || '')}</textarea>
        </div>
        <div style="width:170px">
          <label for="lang-${c.chatId}">Language</label>
          <select id="lang-${c.chatId}">
            <option value=""${!c.lang ? ' selected' : ''}>follow the rules</option>
            ${st.languages.map((l) => `<option value="${l.code}"${c.lang === l.code ? ' selected' : ''}>${esc(l.native)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="row" style="margin-top:9px">
        <button type="button" class="primary" data-contact-save="${c.chatId}">Save</button>
        ${toggle(`block-${c.chatId}`, c.blocked, 'Block this person')}
        <span class="small muted">${c.blocked ? 'ignored completely' : 'block = ignore this chat'}</span>
      </div>
    </div>`).join('')}`;
}

function viewDrafts() {
  const list = S.drafts || [];
  return `
  <div class="card" style="margin-bottom:14px">
    <div class="row" style="justify-content:space-between">
      <div>
        <h2>Drafts</h2>
        <p class="hint" style="margin:0">Suggested replies to people who wrote to your account. Nothing is sent until you press Send. The same cards appear in Telegram.</p>
      </div>
      <div class="seg" id="draftFilter" role="group" aria-label="Filter drafts">
        ${['pending', 'sent', 'ignored'].map((v) => `<button type="button" data-status="${v}" class="${S.draftStatus === v ? 'on' : ''}" aria-pressed="${S.draftStatus === v}">${v[0].toUpperCase()}${v.slice(1)}</button>`).join('')}
      </div>
    </div>
  </div>
  ${list.length === 0 ? '<div class="card muted">Nothing here. When someone messages your account, the draft shows up here and in Telegram.</div>' : ''}
  ${list.map((d) => {
    let reasons = [];
    try { reasons = JSON.parse(d.guard || '[]'); } catch { reasons = []; }
    const statusTag = d.status === 'sent' ? '<span class="tag ok">sent</span>'
      : d.status === 'ignored' ? '<span class="tag">ignored</span>' : '<span class="tag warn">pending</span>';
    return `
    <div class="item" data-draft="${d.id}">
      <div class="meta">
        <strong style="color:var(--text)">${esc(d.name || 'Unknown')}</strong>
        <span>chat ${esc(d.chatId)}</span>
        ${statusTag}
        ${d.lang ? `<span class="tag">${esc(d.lang)}</span>` : ''}
        ${reasons.length ? `<span class="tag bad">guard: ${esc(reasons.join(', '))}</span>` : ''}
        <span style="margin-left:auto">${fmtAgo((d.created || 0) * 1000)}</span>
      </div>
      <div class="quote" dir="auto">${esc(d.incoming)}</div>
      ${d.status === 'pending'
        ? `<textarea data-answer="${d.id}" rows="4" dir="auto" aria-label="Draft reply">${esc(d.answer)}</textarea>
           <div class="row" style="margin-top:9px">
             <button type="button" class="primary" data-send="${d.id}">✅ Send</button>
             <button type="button" data-save="${d.id}">Save edit</button>
             <button type="button" data-regen="${d.id}">🔁 Regenerate</button>
             <button type="button" class="danger" data-ignore="${d.id}">🚫 Ignore</button>
           </div>`
        : `<div class="quote" dir="auto">${esc(d.sentText || d.answer)}</div>`}
    </div>`;
  }).join('')}`;
}

function promptCard(mode, title, hint, data) {
  return `
  <div class="card">
    <h2>${esc(title)}</h2>
    <p class="hint">${esc(hint)}</p>
    <div class="field">
      <label for="prompt-${mode}">Custom prompt ${data.custom ? '<span class="tag ok" style="margin-left:6px">active</span>' : '<span class="tag">using default</span>'}</label>
      <textarea id="prompt-${mode}" rows="14" dir="auto" placeholder="${esc(data.default.slice(0, 400))}">${esc(data.custom || '')}</textarea>
    </div>
    <div class="row end">
      <button type="button" data-prompt-show="${mode}">Show default</button>
      <button type="button" class="danger" data-prompt-reset="${mode}">Reset</button>
      <button type="button" class="primary" data-prompt-save="${mode}">Save</button>
    </div>
  </div>`;
}

function viewPrompts() {
  const p = S.prompts;
  if (!p) return '<div class="card muted">Loading…</div>';
  return `
  <div class="banner info">The code always adds a security line first, your <code>/secretaryinfo</code> after, and the date last. Leave those to the code and write only the behaviour you want.</div>
  <div class="grid cols-2">
    ${promptCard('secretary', 'Secretary prompt', 'How the bot talks to people on your account.', p.secretary)}
    ${promptCard('bot', 'Your private chat prompt', 'How the bot talks to you.', p.bot)}
  </div>`;
}

function viewNotes() {
  return `
  <div class="card" style="margin-bottom:14px">
    <h2>Private notes</h2>
    <p class="hint">Only used in your private chat with the bot. Never shown to anyone who messages your account.</p>
    <div class="row">
      <input id="noteInput" class="grow" placeholder="Something to remember…" dir="auto" aria-label="New note">
      <button type="button" class="primary" id="noteAdd">Add note</button>
    </div>
  </div>
  ${S.notes.length === 0 ? '<div class="card muted">No notes yet.</div>' : ''}
  ${S.notes.map((n) => `
    <div class="item">
      <div class="meta"><span>#${n.id}</span><span style="margin-left:auto">${n.created ? fmtAgo(n.created * 1000) : ''}</span></div>
      <div style="white-space:pre-wrap" dir="auto">${esc(n.text)}</div>
      <div class="row end" style="margin-top:8px"><button type="button" class="danger small" data-note-del="${n.id}">Delete</button></div>
    </div>`).join('')}`;
}

function viewActivity() {
  return `
  <div class="grid cols-2">
    <div class="card">
      <h2>Activity</h2>
      <p class="hint">Messages, drafts, guards and errors.</p>
      ${S.activity.length === 0 ? '<p class="muted">Nothing yet.</p>' : S.activity.map((a) => `
        <div class="item" style="margin-bottom:8px;padding:9px 11px">
          <div class="meta" style="margin:0 0 4px">
            <span class="tag ${a.kind === 'error' ? 'bad' : a.kind === 'blocked' ? 'warn' : a.kind === 'sent' ? 'ok' : ''}">${esc(a.kind)}</span>
            <span style="margin-left:auto">${fmtAgo(a.at * 1000)}</span>
          </div>
          <div class="small" dir="auto" style="overflow-wrap:anywhere">${esc(a.summary)}</div>
        </div>`).join('')}
    </div>
    <div class="card">
      <h2>Runtime log</h2>
      <p class="hint">The last lines this process printed.</p>
      <pre class="log mono">${esc(S.log.map((l) => `${new Date(l.at).toISOString().slice(11, 19)} ${l.message}`).join('\n')) || 'empty'}</pre>
    </div>
  </div>`;
}

function viewSetup() {
  const st = S.state;
  const s = st.settings || {};
  const panel = st.panel || {};
  return `
  <div class="grid cols-2">
    <div class="card">
      <h2>Telegram</h2>
      <p class="hint">The token from @BotFather. It is checked with Telegram before it is saved, so a wrong one cannot break a working bot.</p>
      <div class="field">
        <label for="botToken">Bot token ${st.secrets.botToken ? '<span class="tag ok" style="margin-left:6px">saved</span>' : '<span class="tag bad" style="margin-left:6px">missing</span>'}</label>
        <input id="botToken" type="password" autocomplete="new-password" placeholder="${st.secrets.botToken ? '•••••••• (leave empty to keep)' : '123456789:AA…'}">
      </div>
      <div class="field">
        <label for="ownerId">Owner Telegram id <span class="muted">(empty = unset)</span></label>
        <input id="ownerId" value="${esc(st.owner.id || '')}" placeholder="send /id to the bot">
      </div>
      <div class="field">
        <label for="tz">Timezone (IANA) <span class="muted">(empty = default)</span></label>
        <input id="tz" value="${esc(s.timezone || '')}" placeholder="Europe/London">
      </div>
      <div class="row" style="justify-content:space-between;margin-bottom:6px">
        <div>
          <div>Answer in group chats</div>
          <div class="small muted">Only when someone mentions me or replies to me. Commands still only work in private. Secretary mode never covers groups.</div>
        </div>
        ${toggle('groupSw', (s.group_mode || 'on') !== 'off', 'Answer in group chats when mentioned')}
      </div>
      <div class="row end">
        <button type="button" id="sendTest">Send a test message</button>
        <button type="button" class="primary" id="saveTelegram">Save</button>
      </div>
    </div>

    <div class="card">
      <h2>Model server</h2>
      <p class="hint">A local OpenAI-compatible server. For llama.cpp it is <code>http://127.0.0.1:8080</code>; for Ollama <code>http://127.0.0.1:11434/v1</code>.</p>
      <div class="field">
        <label>Brain</label>
        <div class="seg" id="providerSeg" role="group" aria-label="Brain">
          <button type="button" data-provider="local" class="${(s.llm_provider || 'local') === 'local' ? 'on' : ''}" aria-pressed="${(s.llm_provider || 'local') === 'local'}">Local machine</button>
          <button type="button" data-provider="cloud" class="${s.llm_provider === 'cloud' ? 'on' : ''}" aria-pressed="${s.llm_provider === 'cloud'}">Ollama cloud</button>
        </div>
      </div>
      <div class="field">
        <label for="baseUrl">Server URL</label>
        <input id="baseUrl" value="${esc(s.llm_base_url || st.model.baseUrl || '')}">
      </div>
      <div class="field">
        <label for="modelName">Model name</label>
        <input id="modelName" value="${esc(st.model.name || '')}" placeholder="qwen3-1.7b">
        <p class="hint small" style="margin:6px 0 0">llama-server serves whatever GGUF it was started with; the name is mostly a label. Ollama needs the real tag.</p>
      </div>
      <div class="field">
        <label for="apiKey">API key ${st.secrets.apiKey ? '<span class="tag ok" style="margin-left:6px">saved</span>' : '<span class="tag">not needed locally</span>'}</label>
        <input id="apiKey" type="password" autocomplete="new-password" placeholder="${st.secrets.apiKey ? '•••••••• (leave empty to keep)' : 'only for the cloud brain'}">
      </div>
      <div class="row end">
        <button type="button" class="primary" id="saveModel">Save</button>
      </div>
    </div>
  </div>

  <div class="card" style="margin-top:14px">
    <h2>Access to this panel</h2>
    <p class="hint">Anyone who can reach this port and has the token can control the bot and send messages as you.</p>
    <div class="split">
      <div>
        <h3>Address</h3>
        <div class="mono">${esc(panel.url || '—')}</div>
        <p class="hint small" style="margin-top:6px">Open with <code>?token=…</code> once, or paste the token on the login screen.</p>
      </div>
      <div>
        <h3>Token</h3>
        <div class="mono small">${esc(panel.tokenFile || '')}</div>
        <p class="hint small" style="margin-top:6px">
          ${panel.fixedToken ? 'Fixed by the <code>PANEL_TOKEN</code> setting.' : 'Generated on first start (mode 0600). Delete the file and restart to rotate it.'}
          The token is deliberately not shown here.
        </p>
      </div>
    </div>
    <p class="hint small" style="margin-top:10px">Keep the machine on your LAN: do not port-forward this port. To make the panel local-only, set <code>PANEL_HOST=127.0.0.1</code> and reach it through an SSH tunnel.</p>
    <div class="row end" style="margin-top:10px"><button type="button" id="logoutBtn">Sign out of the panel</button></div>
  </div>`;
}

// --- wiring ---------------------------------------------------------------------
function wire() {
  const st = S.state;
  if (!st) return;

  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      S.tab = b.dataset.tab;
      const active = document.querySelectorAll('[data-tab]');
      active.forEach((x) => {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-current', x === b ? 'page' : 'false');
      });
      S.dirty = false;
      refresh();
    };
  });

  const testBtn = $('#testBtn');
  if (testBtn) {
    testBtn.onclick = async () => {
      const out = $('#testOut');
      const prompt = $('#testText').value;
      testBtn.disabled = true;
      out.textContent = 'generating…';
      try {
        const r = await api('/api/test-model', { method: 'POST', body: JSON.stringify({ text: prompt }) });
        S.test = { prompt, ok: r.ok, answer: r.answer, error: r.error, ms: r.ms };
        out.innerHTML = r.ok
          ? `<span style="color:var(--ok)">${esc((r.ms / 1000).toFixed(1))} s</span> · ${esc((r.answer || '').slice(0, 300))}`
          : `<span style="color:var(--bad)">${esc(r.error)}</span>`;
      } catch (e) {
        S.test = { prompt, ok: false, error: e.message, ms: 0 };
        out.textContent = e.message;
      }
      testBtn.disabled = false;
      S.dirty = true;   // keep the result on screen until the user acts
    };
  }

  const backupBtn = $('#backupBtn');
  if (backupBtn) {
    backupBtn.onclick = async () => {
      try {
        const r = await api('/api/backup', { method: 'POST' });
        toast(r.file ? `Saved to ${r.file}` : 'Nothing to back up');
      } catch (e) { toast(e.message, true); }
    };
  }

  // secretary
  document.querySelectorAll('#modeSeg [data-mode]').forEach((b) => {
    b.onclick = async () => {
      try {
        await saveSettings({ secretary_mode: b.dataset.mode }, `Reply mode set to ${b.dataset.mode}`);
      } catch (e) {
        if (b.dataset.mode === 'auto' && /locked/i.test(e.message)) {
          if (window.confirm(`${e.message}\n\nTurn auto mode on anyway?`)) {
            try { await saveSettings({ secretary_mode: 'auto' }, 'Auto mode on (probe gate overridden)', { force: true }); }
            catch (e2) { toast(e2.message, true); }
          }
          return;
        }
        toast(e.message, true);
      }
    };
  });
  const saveQuiet = $('#saveQuiet');
  if (saveQuiet) {
    saveQuiet.onclick = async () => {
      const patch = { quiet_start: $('#quietStart').value.trim(), quiet_end: $('#quietEnd').value.trim() };
      try { await saveSettings(patch, 'Quiet hours saved'); } catch (e) { toast(e.message, true); }
    };
  }

  const probeBtn = $('#probeBtn');
  if (probeBtn) {
    probeBtn.onclick = async () => {
      probeBtn.disabled = true;
      try {
        await api('/api/probe', { method: 'POST' });
        toast('Probe started — this takes a while');
        // Poll until it finishes rather than leaving the page guessing.
        for (let i = 0; i < 200; i += 1) {
          await new Promise((r) => setTimeout(r, 3000));
          const p = await api('/api/probe');
          if (!p.run.running) {
            toast(p.run.error ? `Probe failed: ${p.run.error}` : `Probe finished: ${p.run.result?.scoreFinal}/${p.run.result?.total}`, Boolean(p.run.error));
            break;
          }
          const card = $('#view .banner.info');
          if (card) card.textContent = `Probing… ${p.run.done}/${p.run.total}`;
        }
        S.dirty = false;
        await refresh({ quiet: false });
      } catch (e) {
        toast(e.message, true);
        probeBtn.disabled = false;
      }
    };
  }

  document.querySelectorAll('[data-contact-save]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.contactSave;
      const notes = document.querySelector(`#notes-${id}`).value;
      const lang = document.querySelector(`#lang-${id}`).value;
      try {
        await api(`/api/contacts/${id}`, { method: 'POST', body: JSON.stringify({ notes, lang }) });
        toast('Saved');
        S.dirty = false;
        await refresh();
      } catch (e) { toast(e.message, true); }
    };
  });
  document.querySelectorAll('[data-contact] [role="switch"]').forEach((el) => {
    const item = el.closest('[data-contact]');
    const id = item?.dataset.contact;
    if (!id) return;
    el.onclick = async () => {
      const next = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', next ? 'true' : 'false');
      try {
        await api(`/api/contacts/${id}`, { method: 'POST', body: JSON.stringify({ blocked: next }) });
        toast(next ? `Chat ${id} blocked` : `Chat ${id} unblocked`);
        S.dirty = false;
        await refresh();
      } catch (e) {
        el.setAttribute('aria-checked', next ? 'false' : 'true');
        toast(e.message, true);
      }
    };
  });

  const langSel = $('#langSel');
  if (langSel) langSel.onchange = () => saveSettings({ lang: langSel.value }, 'Language saved').catch((e) => toast(e.message, true));

  bindToggle('langAuto', (on) => saveSettings({ lang_auto: on ? 'on' : 'off' }, `Language following ${on ? 'on' : 'off'}`));
  bindToggle('notifySw', (on) => saveSettings({ notify: on ? 'on' : 'off' }, `Notifications ${on ? 'on' : 'off'}`));
  bindToggle('groupSw', (on) => saveSettings({ group_mode: on ? 'on' : 'off' }, on
    ? 'I will answer in groups when mentioned'
    : 'I will stay silent in groups'));

  const delay = $('#delayRange');
  if (delay) {
    delay.oninput = () => { $('#delayVal').textContent = delay.value; S.dirty = true; };
    delay.onchange = () => saveSettings({ delay_seconds: delay.value }, 'Delay saved').catch((e) => toast(e.message, true));
  }
  const pause = $('#pauseHours');
  if (pause) pause.onchange = () => saveSettings({ pause_hours: pause.value }, 'Pause saved').catch((e) => toast(e.message, true));

  const infoBtn = $('#saveInfoBtn');
  if (infoBtn) infoBtn.onclick = () => saveSettings({ secretary_info: $('#secretaryInfo').value }, 'Saved').catch((e) => toast(e.message, true));

  // drafts
  document.querySelectorAll('#draftFilter [data-status]').forEach((b) => {
    b.onclick = () => { S.draftStatus = b.dataset.status; S.dirty = false; refresh(); };
  });
  document.querySelectorAll('[data-send]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.send;
      const text = document.querySelector(`[data-answer="${id}"]`).value;
      b.disabled = true;
      try {
        await api(`/api/drafts/${id}/send`, { method: 'POST', body: JSON.stringify({ text }) });
        toast('Sent ✅');
        await refresh();
      } catch (e) { toast(e.message, true); b.disabled = false; }
    };
  });
  document.querySelectorAll('[data-save]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.save;
      const text = document.querySelector(`[data-answer="${id}"]`).value;
      try {
        await api(`/api/drafts/${id}`, { method: 'PUT', body: JSON.stringify({ text }) });
        toast('Draft saved');
        S.dirty = false;
      } catch (e) { toast(e.message, true); }
    };
  });
  document.querySelectorAll('[data-regen]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = '🔁 thinking…';
      try { await api(`/api/drafts/${b.dataset.regen}/regen`, { method: 'POST' }); await refresh(); }
      catch (e) { toast(e.message, true); b.disabled = false; b.textContent = '🔁 Regenerate'; }
    };
  });
  document.querySelectorAll('[data-ignore]').forEach((b) => {
    b.onclick = async () => {
      try { await api(`/api/drafts/${b.dataset.ignore}/ignore`, { method: 'POST' }); toast('Ignored'); await refresh(); }
      catch (e) { toast(e.message, true); }
    };
  });

  // prompts
  document.querySelectorAll('[data-prompt-save]').forEach((b) => {
    b.onclick = async () => {
      const mode = b.dataset.promptSave;
      const text = $(`#prompt-${mode}`).value;
      try {
        await api('/api/prompts', { method: 'POST', body: JSON.stringify({ mode, text }) });
        toast('Prompt saved');
        S.dirty = false;
        await refresh();
      } catch (e) { toast(e.message, true); }
    };
  });
  document.querySelectorAll('[data-prompt-reset]').forEach((b) => {
    b.onclick = async () => {
      const mode = b.dataset.promptReset;
      if (!window.confirm(`Reset the ${mode} prompt to the built-in default?`)) return;
      try {
        await api('/api/prompts', { method: 'POST', body: JSON.stringify({ mode, text: '' }) });
        toast('Reset');
        await refresh();
      } catch (e) { toast(e.message, true); }
    };
  });
  document.querySelectorAll('[data-prompt-show]').forEach((b) => {
    b.onclick = async () => {
      const mode = b.dataset.promptShow;
      try {
        const prompts = S.prompts || await api('/api/prompts');
        $(`#prompt-${mode}`).value = prompts[mode].default;
        S.dirty = true;
        toast('Showing the default — edit and save to make it custom');
      } catch (e) { toast(e.message, true); }
    };
  });

  // notes
  const add = $('#noteAdd');
  if (add) {
    add.onclick = async () => {
      const input = $('#noteInput');
      if (!input.value.trim()) return;
      try {
        await api('/api/notes', { method: 'POST', body: JSON.stringify({ text: input.value }) });
        input.value = '';
        S.dirty = false;
        await refresh();
      } catch (e) { toast(e.message, true); }
    };
  }
  document.querySelectorAll('[data-note-del]').forEach((b) => {
    b.onclick = async () => {
      try { await api(`/api/notes/${b.dataset.noteDel}`, { method: 'DELETE' }); await refresh(); }
      catch (e) { toast(e.message, true); }
    };
  });

  // setup
  document.querySelectorAll('#providerSeg [data-provider]').forEach((b) => {
    b.onclick = () => saveSettings({ llm_provider: b.dataset.provider }, `Brain set to ${b.dataset.provider}`)
      .catch((e) => toast(e.message, true));
  });

  const saveTelegram = $('#saveTelegram');
  if (saveTelegram) {
    saveTelegram.onclick = async () => {
      const patch = {};
      const token = $('#botToken').value.trim();
      if (token) patch.bot_token = token;
      // Owner and timezone are always sent, so they can be cleared again.
      patch.owner_id = $('#ownerId').value.trim();
      patch.timezone = $('#tz').value.trim();
      if (!token && !patch.owner_id && !patch.timezone) {
        try { await saveSettings(patch, 'Cleared the owner and timezone'); } catch (e) { toast(e.message, true); }
        return;
      }
      try { await saveSettings(patch, 'Saved'); } catch (e) { toast(e.message, true); }
    };
  }

  const saveModel = $('#saveModel');
  if (saveModel) {
    saveModel.onclick = async () => {
      const patch = { model: $('#modelName').value.trim(), llm_base_url: $('#baseUrl').value.trim() };
      const key = $('#apiKey').value.trim();
      if (key) patch.llm_api_key = key;
      try { await saveSettings(patch, 'Model settings saved'); } catch (e) { toast(e.message, true); }
    };
  }

  const sendTest = $('#sendTest');
  if (sendTest) {
    sendTest.onclick = async () => {
      try { await api('/api/send-test', { method: 'POST' }); toast('Test message sent to your Telegram'); }
      catch (e) { toast(e.message, true); }
    };
  }

  const logoutBtn = $('#logoutBtn');
  if (logoutBtn) {
    logoutBtn.onclick = async () => {
      try {
        await api('/api/logout', { method: 'POST' });
        saveToken('');
        showLogin(true);
        S.state = null;
        $('#view').innerHTML = '';
        toast('Signed out');
      } catch (e) { toast(e.message, true); }
    };
  }

  const refreshBtn = $('#refreshBtn');
  if (refreshBtn) refreshBtn.onclick = () => refresh({ quiet: false });
}

function bindToggle(id, onToggle) {
  const el = $(`#${id}`);
  if (!el) return;
  el.onclick = () => {
    const next = el.getAttribute('aria-checked') !== 'true';
    el.setAttribute('aria-checked', next ? 'true' : 'false');
    onToggle(next).catch((e) => {
      el.setAttribute('aria-checked', next ? 'false' : 'true');
      toast(e.message, true);
    });
  };
}

async function saveSettings(patch, okMessage, extra = {}) {
  await api('/api/settings', { method: 'POST', body: JSON.stringify({ settings: patch, ...extra }) });
  toast(okMessage || 'Saved');
  S.dirty = false;
  await refresh();
}

// --- boot -----------------------------------------------------------------------
$('#loginBtn').onclick = async () => {
  try {
    // signIn sends the token in the body and as a header: if a proxy drops one,
    // the other still signs us in.
    await signIn($('#tokenInput').value.trim());
  } catch (e) {
    $('#loginErr').textContent = e.message;
    $('#loginErr').style.color = 'var(--bad)';
  }
};
$('#tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginBtn').click(); });

// Anything typed into the view marks the page dirty, so the 5-second refresh
// cannot wipe an unsaved draft, prompt or note.
$('#view').addEventListener('input', () => { S.dirty = true; });
$('#view').addEventListener('change', () => { S.dirty = true; });

// Keep the panel live — but never under the user's hands.
setInterval(() => {
  if (document.hidden || S.dirty) return;
  const typing = document.activeElement && ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName);
  if (typing) return;
  refresh();
}, 5000);

// A demo panel says so, everywhere it is visible: nobody should think they are
// looking at their own data, and nobody should think this build is unprotected by
// accident.
function markDemo() {
  const sub = $('#brandSub');
  if (sub && !sub.textContent.includes('demo')) sub.textContent = 'demo · sample data, no password';
  document.title = 'Secretary — demo panel';
}

async function signIn(token) {
  const body = await api('/api/login', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ token }),
  });
  saveToken(body.token || token);
  $('#tokenInput').value = '';
  $('#loginErr').textContent = '';
  showLogin(false);
  await refresh({ quiet: false });
}

(async () => {
  // "/?token=…" signs this tab in. Keep it in sessionStorage and take it out of
  // the address bar, so it does not survive in history, a screenshot or a link
  // someone was sent.
  let fromUrl = '';
  try {
    fromUrl = new URL(location.href).searchParams.get('token') || '';
    if (fromUrl) history.replaceState(null, '', location.pathname + location.hash);
  } catch { /* no URL API: the header path still works */ }
  if (fromUrl) saveToken(fromUrl.trim());

  try {
    const ping = await api('/api/ping');

    // A demo instance (sample data, no bot token) is open by design: the token is
    // in the README, so a login wall in front of it protects nothing and only
    // gives a proxy something to break. Take the token from the ping — never
    // through a login request, which is the one thing an embedded pane was seen
    // to mangle — and label the page so nobody mistakes it for their own data.
    if (ping.demo) {
      markDemo();
      if (ping.demoToken) {
        saveToken(ping.demoToken);
        if ($('#tokenInput')) $('#tokenInput').value = ping.demoToken;
      }
    }

    // Nothing else to do: the session is already good (cookie, header, or a demo
    // instance that needs neither).
    if (!ping.needsAuth) {
      try {
        await refresh({ quiet: false });
        return;
      } catch (e) {
        if (!ping.demo) throw e;
      }
    }

    const hint = $('#loginHint');
    if (hint) {
      hint.innerHTML = ping.demo
        ? `This is the <strong>demo</strong> panel. The token is <code>${esc(ping.demoToken || 'demo')}</code>.`
        : 'The token is printed by the bot when it starts, and stored in <code>bot/state/panel-token</code>. You can also open the panel with <code>?token=…</code>.';
    }
    showLogin(true);
  } catch (e) {
    showLogin(true);
  }
})();
