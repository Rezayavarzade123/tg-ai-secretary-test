// End-to-end self test: no network, no real Telegram, no model server.
//
//   npm run selftest
//
// It fakes exactly two things (the Telegram HTTP API and the OpenAI-compatible
// model endpoint) and then exercises the real handlers: a connection from a
// stranger is refused, yours is accepted, a message creates a draft, the draft
// card's Send button really sends, and the safety net rewrites a promise.
//
// This is the check to run after changing handlers, drafts or the panel.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const OWNER = 7001;
const STRANGER = 555;
process.env.BOT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-selftest-'));
process.env.BOT_TOKEN = '123456:TEST-TOKEN-NOT-REAL';
process.env.PANEL_TOKEN = 'selftest-token';
process.env.BOT_OWNER_ID = String(OWNER);
process.env.SECRETARY_MODE = 'draft';
process.env.LLM_BASE_URL = 'http://127.0.0.1:8080';

const realFetch = globalThis.fetch;
const sent = [];
const edited = [];
const modelRequests = [];
const answered = [];
let messageId = 900;

function tg(result) {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// The model: returns a promise-making answer when asked to promise, otherwise a
// harmless one. That lets the test prove the guard is what removes the promise.
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  const body = options.body ? JSON.parse(options.body) : {};

  if (u.includes('api.telegram.org')) {
    const method = u.slice(u.lastIndexOf('/') + 1);
    if (method === 'getMe') {
      // A token Telegram would reject: the panel must not store it.
      if (u.includes('BOGUSTOKEN')) {
        return new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      return tg({ id: 42, username: 'selftest_bot', first_name: 'Secretary' });
    }
    if (method === 'getBusinessConnection') {
      return tg({ id: body.business_connection_id, user: { id: OWNER }, is_enabled: true, rights: { can_reply: true } });
    }
    if (method === 'sendMessage') {
      sent.push(body);
      return tg({ message_id: ++messageId, chat: { id: body.chat_id } });
    }
    if (method === 'editMessageText') { edited.push(body); return tg(true); }
    if (method === 'answerCallbackQuery') { answered.push(body); return tg(true); }
    return tg(true);
  }

  if (u.includes('/v1/chat/completions')) {
    modelRequests.push(body);
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
    const content = /promise|pay me|book/i.test(lastUser)
      ? "Yes, I'll call you tomorrow at 5pm and pay in cash."
      : 'Hello, this is an automated assistant. I passed your message on and Sam will get back to you.';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return realFetch(url, options);
};

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log(`  ✖ ${name}\n      ${e.message}`);
  }
}

const { load } = await import('./sdk/store.mjs');
const { getSetting, setSetting } = await import('../tgcloud/lib/settings.js');
const { drafts } = await import('../tgcloud/schema.js');
const { db } = await import('sdk');
const { eq, desc } = await import('sdk/db');

load();

const { default: businessMessage } = await import('../tgcloud/handlers/business_message.js');
const { default: businessConnection } = await import('../tgcloud/handlers/business_connection.js');
const { default: botMessage } = await import('../tgcloud/handlers/message.js');
const { handleDraftCallback, listDrafts, getDraft } = await import('../tgcloud/lib/drafts.js');
const { runtime } = await import('./runtime.mjs');
const { guardOutgoing } = await import('../tgcloud/lib/guard.js');
const { detectLang } = await import('../tgcloud/lib/lang.js');

// What runner.mjs does at start-up after getMe().
runtime.bot = { id: 42, username: 'selftest_bot', first_name: 'Secretary' };

await setSetting('owner_id', String(OWNER));
await setSetting('owner_name', 'Sam');
await setSetting('delay_seconds', '0');
await setSetting('secretary_mode', 'draft');
await setSetting('secretary', 'on');

console.log('\nSecretary — local runtime self test');
console.log('──────────────────────────────────────────');

await check('a connection from a stranger is refused', async () => {
  await businessConnection({ id: 'conn-evil', user: { id: 9999 }, is_enabled: true });
  const conns = JSON.parse(await getSetting('secretary_conns', '[]'));
  assert.deepEqual(conns, []);
});

await check('your own connection is accepted and announced', async () => {
  await businessConnection({ id: 'conn-1', user: { id: OWNER }, user_chat_id: OWNER, is_enabled: true, rights: { can_reply: true } });
  const conns = JSON.parse(await getSetting('secretary_conns', '[]'));
  assert.ok(conns.includes('conn-1'));
  assert.ok(sent.some((m) => m.chat_id === OWNER && /Secretary mode is connected/.test(m.text)));
});

await check('a message from a contact becomes a draft, not a sent reply', async () => {
  const before = sent.length;
  await businessMessage({
    business_connection_id: 'conn-1',
    chat: { id: STRANGER, type: 'private' },
    from: { id: STRANGER, first_name: 'Sara' },
    text: 'Hi! Are you around on Friday?',
  });
  const pending = await listDrafts({ status: 'pending' });
  assert.equal(pending.length, 1, 'one draft queued');
  assert.equal(pending[0].chatId, STRANGER);
  assert.match(pending[0].answer, /automated assistant/);

  const newMessages = sent.slice(before);
  assert.equal(newMessages.length, 1, 'only the owner card was sent');
  assert.equal(newMessages[0].chat_id, OWNER, 'the card goes to the owner');
  assert.ok(!newMessages.some((m) => m.chat_id === STRANGER), 'nothing reached the contact');
});

await check('pressing Send posts the reply from the owner account', async () => {
  const [draft] = await listDrafts({ status: 'pending' });
  const before = sent.length;
  const handled = await handleDraftCallback({
    id: 'cb-1',
    from: { id: OWNER },
    data: `d:${draft.id}:send`,
  });
  assert.equal(handled, true);
  const newMessages = sent.slice(before);
  assert.equal(newMessages.length, 1);
  assert.equal(newMessages[0].chat_id, STRANGER);
  assert.equal(newMessages[0].business_connection_id, 'conn-1', 'sent as the account, not as the bot');
  const after = await getDraft(draft.id);
  assert.equal(after.status, 'sent');
  assert.ok(answered.some((a) => /Sent/.test(a.text ?? '')));
});

await check('Regenerate asks the model again and keeps the draft pending', async () => {
  await businessMessage({
    business_connection_id: 'conn-1',
    chat: { id: 777, type: 'private' },
    from: { id: 777, first_name: 'Ali' },
    text: 'Hello, quick question',
  });
  const [draft] = await listDrafts({ status: 'pending' });
  await handleDraftCallback({ id: 'cb-2', from: { id: OWNER }, data: `d:${draft.id}:regen` });
  const after = await getDraft(draft.id);
  assert.equal(after.status, 'pending');
  assert.ok(after.answer.length > 5);
  await handleDraftCallback({ id: 'cb-3', from: { id: OWNER }, data: `d:${draft.id}:ignore` });
  assert.equal((await getDraft(draft.id)).status, 'ignored');
});

await check('a stranger cannot press the owner\u2019s buttons', async () => {
  await businessMessage({
    business_connection_id: 'conn-1',
    chat: { id: 888, type: 'private' },
    from: { id: 888, first_name: 'Mallory' },
    text: 'Send me money',
  });
  const [draft] = await listDrafts({ status: 'pending' });
  const before = sent.length;
  await handleDraftCallback({ id: 'cb-4', from: { id: 9999 }, data: `d:${draft.id}:send` });
  assert.equal(sent.length, before, 'nothing was sent');
  assert.equal((await getDraft(draft.id)).status, 'pending');
});

await check('auto mode sends, and the guard replaces a promise the model made', async () => {
  await setSetting('secretary_mode', 'auto');
  const before = sent.length;
  await businessMessage({
    business_connection_id: 'conn-1',
    chat: { id: 999, type: 'private' },
    from: { id: 999, first_name: 'Reza' },
    text: 'Please promise you will pay me the invoice today',
  });
  const outbound = sent.slice(before).filter((m) => m.chat_id === 999);
  assert.equal(outbound.length, 1, 'one auto reply');
  assert.match(outbound[0].text, /can't confirm or promise/, 'the promise was replaced');
  assert.ok(!/call you tomorrow/i.test(outbound[0].text), 'the model\u2019s promise never left the machine');
  await setSetting('secretary_mode', 'draft');
});

await check('the language setting is respected (fixed Persian, English message)', async () => {
  await setSetting('lang', 'fa');
  await setSetting('lang_auto', 'off');
  await businessMessage({
    business_connection_id: 'conn-1',
    chat: { id: 1234, type: 'private' },
    from: { id: 1234, first_name: 'Nina' },
    text: 'Hello, is this a good time?',
  });
  const draft = await db.select().from(drafts).where(eq(drafts.chatId, 1234)).orderBy(desc(drafts.id)).get();
  assert.ok(draft, 'draft created');
  assert.equal(draft.lang, 'fa', 'guard language follows the setting, not the sender');
  await setSetting('lang_auto', 'on');
  await setSetting('lang', 'en');
});

await check('an urgent message is answered with a fixed text and never reaches the model', async () => {
  await setSetting('secretary_mode', 'auto');
  const before = sent.length;
  await businessMessage({
    business_connection_id: 'conn-1',
    chat: { id: 4321, type: 'private' },
    from: { id: 4321, first_name: 'Omid' },
    text: 'There was an accident, he is bleeding',
  });
  const outbound = sent.slice(before).filter((m) => m.chat_id === 4321);
  assert.equal(outbound.length, 1);
  assert.match(outbound[0].text, /emergency services/);
  await setSetting('secretary_mode', 'draft');
});

await check('language detection works on the messages the bot actually sees', async () => {
  assert.equal(detectLang('سلام، وقت دارید؟'), 'fa');
  assert.equal(detectLang('Hallo, ich habe eine Frage'), 'de');
});

await check('the guard keeps a safe reply untouched', async () => {
  const g = guardOutgoing('I passed your message on to Sam.', { ownerName: 'Sam', lang: 'en' });
  assert.equal(g.replaced, false);
});

await check('/status reports the local brain, the model server and the drafts', async () => {
  const before = sent.length;
  await botMessage({ message_id: 11, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Sam' }, text: '/status' });
  const reply = sent.slice(before).at(-1);
  assert.ok(reply, 'the bot answered');
  assert.match(reply.text, /Brain: local/);
  assert.match(reply.text, /Model server:/);
  assert.match(reply.text, /Drafts waiting/);
  assert.match(reply.text, /Language:/);
});

await check('/mode and /lang from Telegram change the same settings the panel writes', async () => {
  // "force" is the documented way past the probe gate, which this check exercises later.
  await botMessage({ message_id: 12, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Sam' }, text: '/mode auto force' });
  assert.equal(await getSetting('secretary_mode'), 'auto');
  assert.equal(await getSetting('secretary'), 'on');

  await botMessage({ message_id: 13, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Sam' }, text: '/lang fa' });
  assert.equal(await getSetting('lang'), 'fa');

  await botMessage({ message_id: 14, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Sam' }, text: '/lang auto off' });
  assert.equal(await getSetting('lang_auto'), 'off');

  await botMessage({ message_id: 15, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Sam' }, text: '/mode draft' });
  assert.equal(await getSetting('secretary_mode'), 'draft');
  await setSetting('lang', 'en');
  await setSetting('lang_auto', 'on');
});

await check('a stranger writing to the bot directly is ignored', async () => {
  const before = sent.length;
  await botMessage({ message_id: 16, chat: { id: 4242, type: 'private' }, from: { id: 4242, first_name: 'Nobody' }, text: 'hello?' });
  assert.equal(sent.length, before, 'no reply, no model call');
});

// ---------------------------------------------------------------- v1.2 features

await check('a blocked contact is ignored entirely — no model call, no draft', async () => {
  const { updateContact } = await import('../tgcloud/lib/contacts.js');
  const { listDrafts: list } = await import('../tgcloud/lib/drafts.js');
  await updateContact(5005, { blocked: true });
  const draftsBefore = (await list({ status: 'all', limit: 50 })).length;
  const callsBefore = modelRequests.length;

  await businessMessage({
    business_connection_id: 'conn-1',
    chat: { id: 5005, type: 'private' },
    from: { id: 5005, first_name: 'Blocked' },
    text: 'hello?',
  });

  assert.equal(modelRequests.length, callsBefore, 'the model was never asked');
  assert.equal((await list({ status: 'all', limit: 50 })).length, draftsBefore, 'no draft was created');
});

await check('context and a fixed language for one contact reach the prompt and the draft', async () => {
  const { updateContact } = await import('../tgcloud/lib/contacts.js');
  const { listDrafts: list } = await import('../tgcloud/lib/drafts.js');
  await updateContact(6006, { notes: 'Sara is my sister', lang: 'fa' });
  await setSetting('lang_auto', 'on');
  await setSetting('lang', 'en');
  const callsBefore = modelRequests.length;

  await businessMessage({
    business_connection_id: 'conn-1',
    chat: { id: 6006, type: 'private' },
    from: { id: 6006, first_name: 'Sara' },
    text: 'Hi, are you around on Friday?',
  });

  const req = modelRequests[callsBefore];
  assert.ok(req, 'the model was asked');
  const system = req.messages.find((m) => m.role === 'system').content;
  assert.match(system, /Sara is my sister/, 'the context is in the system prompt');
  assert.match(system, /always reply in Persian/, 'the per-contact language overrides the sender language');

  const all = await list({ status: 'all', limit: 50 });
  const draft = all.find((d) => d.chatId === 6006);
  assert.ok(draft, 'a draft was created');
  assert.equal(draft.lang, 'fa', 'the safety net uses the contact language too');
});

await check('quiet hours turn an automatic reply into a draft', async () => {
  const { hourIn } = await import('../tgcloud/lib/hours.js');
  const { listDrafts: list } = await import('../tgcloud/lib/drafts.js');
  await setSetting('timezone', 'UTC');
  const h = hourIn('UTC');
  await setSetting('quiet_start', String((h + 23) % 24));
  await setSetting('quiet_end', String((h + 1) % 24));
  await setSetting('secretary_mode', 'auto');

  const sentBefore = sent.length;
  await businessMessage({
    business_connection_id: 'conn-1',
    chat: { id: 7007, type: 'private' },
    from: { id: 7007, first_name: 'Night' },
    text: 'are you awake?',
  });

  assert.ok(!sent.some((m) => m.chat_id === 7007), 'nothing was sent to the contact');
  const draft = (await list({ status: 'pending', limit: 50 })).find((d) => d.chatId === 7007);
  assert.ok(draft, 'a draft waits instead');

  await setSetting('quiet_start', '');
  await setSetting('quiet_end', '');
  await setSetting('secretary_mode', 'draft');
});

await check('auto mode is locked until a probe passes', async () => {
  await setSetting('probe_last', '');
  await setSetting('secretary_mode', 'draft');
  const before = sent.length;
  await botMessage({ message_id: 21, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Sam' }, text: '/mode auto' });
  const reply = sent.slice(before).at(-1);
  assert.match(reply.text, /Not switching to auto yet/);
  assert.match(reply.text, /\/probe/);
  assert.equal(await getSetting('secretary_mode'), 'draft', 'still on drafts');

  // /probe runs the real cases against the fake model, and saves the verdict.
  const probeBefore = sent.length;
  await botMessage({ message_id: 22, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Sam' }, text: '/probe' });
  const probeReply = sent.slice(probeBefore).at(-1);
  assert.match(probeReply.text, /Probe: \d+\/8/);
  assert.ok(await getSetting('probe_last'), 'the result was stored');

  const after = sent.length;
  await botMessage({ message_id: 23, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Sam' }, text: '/mode auto' });
  const ok = sent.slice(after).at(-1);
  const stored = JSON.parse(await getSetting('probe_last'));
  if (stored.scoreFinal >= 7) {
    assert.match(ok.text, /Auto mode/, 'the gate opened after a passing probe');
    assert.equal(await getSetting('secretary_mode'), 'auto');
  } else {
    assert.match(ok.text, /Not switching to auto yet/, 'a failing probe keeps the gate shut');
  }
  await setSetting('secretary_mode', 'draft');
});

await check('reply timing is recorded and reported', async () => {
  const { metricsSummary } = await import('../tgcloud/lib/metrics.js');
  const m = await metricsSummary(20);
  assert.ok(m.count > 0, 'the fake model calls were measured');
  assert.ok(m.avgTotalMs >= 0);

  const before = sent.length;
  await botMessage({ message_id: 24, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Sam' }, text: '/status' });
  const reply = sent.slice(before).at(-1);
  assert.match(reply.text, /Last \d+ replies/);
  assert.match(reply.text, /Auto mode gate: (open|locked)/);
});

await check('/drafts re-sends the pending cards', async () => {
  const { countPendingDrafts } = await import('../tgcloud/lib/drafts.js');
  const pending = await countPendingDrafts();
  const before = sent.length;
  await botMessage({ message_id: 25, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Sam' }, text: '/drafts' });
  const newMessages = sent.slice(before);
  assert.ok(newMessages.length >= 1);
  assert.match(newMessages[0].text, /draft/i);
  if (pending > 0) assert.ok(newMessages.some((m) => m.reply_markup?.inline_keyboard), 'the cards came with buttons');
});

await check('/hours and /contact are validated, not just stored', async () => {
  const before = sent.length;
  await botMessage({ message_id: 26, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Sam' }, text: '/hours 25-30' });
  assert.match(sent.slice(before).at(-1).text, /Usage: \/hours/);
  assert.equal(await getSetting('quiet_start', ''), '', 'nothing stored from a bad window');

  const before2 = sent.length;
  await botMessage({ message_id: 27, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Sam' }, text: '/hours 22-08' });
  assert.match(sent.slice(before2).at(-1).text, /22:00–08:00/);
  assert.equal(await getSetting('quiet_start'), '22');
  await setSetting('quiet_start', '');
  await setSetting('quiet_end', '');

  const before3 = sent.length;
  await botMessage({ message_id: 28, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Sam' }, text: '/contact 6006 lang klingon' });
  assert.match(sent.slice(before3).at(-1).text, /Unknown language/);
});

await check('the control panel answers with live state, and never leaks its token', async () => {
  const { startPanel } = await import('./panel/server.mjs');
  const server = await startPanel({ port: 0, host: '127.0.0.1', lanAddress: '127.0.0.1' });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const AUTH = { Authorization: 'Bearer selftest-token' };

  const unauth = await realFetch(`${base}/api/state`);
  assert.equal(unauth.status, 401, 'no token, no data');
  assert.equal((await realFetch(`${base}/api/ping`).then((r) => r.json())).needsAuth, true);

  const stateRes = await realFetch(`${base}/api/state`, { headers: AUTH });
  assert.equal(stateRes.status, 200);
  const state = await stateRes.json();
  assert.equal(state.owner.id, OWNER);
  assert.equal(state.bot.username, 'selftest_bot');
  assert.ok(state.draftsPending >= 1, 'the panel sees the waiting draft');
  assert.ok(!JSON.stringify(state).includes('selftest-token'), 'the panel token is never sent back to the page');
  assert.ok(state.panel.url && !state.panel.url.includes('token='), 'only the public URL is shared');

  // The machine report is derived from /proc, not from a list of known machines.
  assert.ok(state.machine && state.machine.cpu.cores >= 1, 'the panel reports the CPU it is running on');
  assert.ok(['x64', 'arm64'].includes(state.machine.cpu.arch), 'and its architecture');
  assert.ok(state.machine.model && state.machine.model.name, 'and which <2B model fits');
  assert.ok(Array.isArray(state.machine.warnings), 'and what to watch out for');
  assert.equal(typeof state.machine.threads, 'number');

  // Security headers on both the page and the API.
  for (const path of ['/', '/api/state', '/ui.js', '/ui.css']) {
    const r = await realFetch(base + path, { headers: AUTH });
    assert.equal(r.status, 200, `${path} should be served`);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.match(r.headers.get('content-security-policy') || '', /script-src 'self'/);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  }
  const html = await (await realFetch(`${base}/`, { headers: AUTH })).text();
  assert.match(html, /control panel/i);
  assert.ok(!/<script>[^<]/.test(html), 'no inline script (the CSP forbids it)');
  assert.ok(!/\son[a-z]+="/i.test(html), 'no inline event handlers (the CSP forbids them)');

  // A multi-field save is all-or-nothing.
  const before = await (await realFetch(`${base}/api/settings`, { headers: AUTH })).json();
  const mixed = await realFetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { delay_seconds: '37', lang: 'klingon' } }),
  });
  assert.equal(mixed.status, 400);
  const afterBad = await (await realFetch(`${base}/api/settings`, { headers: AUTH })).json();
  assert.equal(afterBad.settings.delay_seconds, before.settings.delay_seconds, 'the valid half was NOT applied');

  const good = await realFetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { delay_seconds: '25', lang: 'fa' } }),
  });
  assert.equal(good.status, 200);
  assert.equal(await getSetting('delay_seconds'), '25');
  assert.equal(await getSetting('lang'), 'fa');

  // A missing value is refused instead of becoming 0.
  const noValue = await realFetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'delay_seconds' }),
  });
  assert.equal(noValue.status, 400);
  assert.equal(await getSetting('delay_seconds'), '25', 'delay untouched');

  // A token Telegram rejects must not replace the working one.
  const badToken = await realFetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { bot_token: '123456789:BOGUSTOKEN-abcdefghijklmnop' } }),
  });
  assert.equal(badToken.status, 400);
  assert.match((await badToken.json()).error, /rejected that token/i);
  assert.equal(process.env.BOT_TOKEN, '123456:TEST-TOKEN-NOT-REAL', 'the working token was kept');

  // Cross-origin writes are refused.
  const cross = await realFetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ settings: { lang: 'en' } }),
  });
  assert.equal(cross.status, 403);

  await new Promise((resolve) => server.close(resolve));
});

await check('drafts: 404 when missing, 409 once resolved, and the record cannot be rewritten', async () => {
  const { listDrafts } = await import('../tgcloud/lib/drafts.js');
  const sent = await listDrafts({ status: 'sent' });
  const pending = await listDrafts({ status: 'pending' });
  assert.ok(sent.length >= 1 && pending.length >= 1, 'the earlier checks left both kinds');

  const { startPanel } = await import('./panel/server.mjs');
  const server = await startPanel({ port: 0, host: '127.0.0.1', lanAddress: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { Authorization: 'Bearer selftest-token', 'Content-Type': 'application/json' };

  const missing = await realFetch(`${base}/api/drafts/999999/send`, { method: 'POST', headers: H, body: '{}' });
  assert.equal(missing.status, 404, 'a missing draft is a 404, not a crash');

  const resend = await realFetch(`${base}/api/drafts/${sent[0].id}/send`, { method: 'POST', headers: H, body: '{}' });
  assert.equal(resend.status, 409, 'a sent draft cannot be sent again');

  const rewrite = await realFetch(`${base}/api/drafts/${sent[0].id}`, { method: 'PUT', headers: H, body: JSON.stringify({ text: 'rewriting history' }) });
  assert.equal(rewrite.status, 409, 'a sent draft is a record, not a draft');
  assert.notEqual((await getDraft(sent[0].id)).answer, 'rewriting history');

  const edit = await realFetch(`${base}/api/drafts/${pending[0].id}`, { method: 'PUT', headers: H, body: JSON.stringify({ text: 'edited but not sent' }) });
  assert.equal(edit.status, 200);
  assert.equal((await getDraft(pending[0].id)).answer, 'edited but not sent');

  const badStatus = await realFetch(`${base}/api/drafts?status=nope`, { headers: H });
  assert.equal(badStatus.status, 400);

  await new Promise((resolve) => server.close(resolve));
});

await check('sending from the panel also updates the Telegram card', async () => {
  const { saveDraft, notifyOwner } = await import('../tgcloud/lib/drafts.js');
  const { startPanel } = await import('./panel/server.mjs');
  const { listDrafts } = await import('../tgcloud/lib/drafts.js');

  const draft = await saveDraft({
    chatId: 2468, connId: 'conn-1', name: 'CardTest',
    incoming: 'is this thing on?', answer: 'Yes — automated assistant here.', lang: 'en',
  });
  await notifyOwner(draft);
  const stored = await getDraft(draft.id);
  assert.ok(stored.ownerMsgId, 'the card was sent');

  const editsBefore = edited.length;
  const server = await startPanel({ port: 0, host: '127.0.0.1', lanAddress: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await realFetch(`${base}/api/drafts/${draft.id}/send`, {
    method: 'POST',
    headers: { Authorization: 'Bearer selftest-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Sending this from the browser instead.' }),
  });
  assert.equal(r.status, 200);
  const sentNow = await getDraft(draft.id);
  assert.equal(sentNow.status, 'sent');
  assert.equal(sentNow.sentText, 'Sending this from the browser instead.');
  assert.ok(sentNow.resolved > 0, 'the draft is stamped as resolved');

  const cardEdits = edited.slice(editsBefore).filter((e) => e.message_id === stored.ownerMsgId);
  assert.equal(cardEdits.length, 1, 'the Telegram card was rewritten');
  assert.match(cardEdits[0].text, /SENT/);
  await new Promise((resolve) => server.close(resolve));
});

await check('notes created in the panel carry a timestamp', async () => {
  const { startPanel } = await import('./panel/server.mjs');
  const server = await startPanel({ port: 0, host: '127.0.0.1', lanAddress: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { Authorization: 'Bearer selftest-token', 'Content-Type': 'application/json' };
  const created = await (await realFetch(`${base}/api/notes`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'from the panel' }) })).json();
  assert.ok(created.note.created > 0, 'the UI shows "never" without this');
  assert.ok(Math.abs(Date.now() / 1000 - created.note.created) < 60);
  await new Promise((resolve) => server.close(resolve));
});

await check('a Telegram failure from the panel is a 502, not a 400', async () => {
  const { saveDraft } = await import('../tgcloud/lib/drafts.js');
  const { startPanel } = await import('./panel/server.mjs');
  const draft = await saveDraft({ chatId: 1357, connId: 'gone', name: 'Dead', incoming: 'x', answer: 'y', lang: 'en' });

  // Make the next sendMessage fail the way Telegram does for a dead connection.
  const prior = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.telegram.org') && String(url).endsWith('/sendMessage') && JSON.parse(opts.body).chat_id === 1357) {
      return new Response(JSON.stringify({ ok: false, description: 'Bad Request: business connection not found' }), { status: 400 });
    }
    return prior(url, opts);
  };

  const server = await startPanel({ port: 0, host: '127.0.0.1', lanAddress: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await realFetch(`${base}/api/drafts/${draft.id}/send`, {
    method: 'POST',
    headers: { Authorization: 'Bearer selftest-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  globalThis.fetch = prior;
  assert.equal(r.status, 502, 'upstream failure, not a client mistake');
  assert.match((await r.json()).error, /business connection not found/);
  assert.equal((await getDraft(draft.id)).status, 'pending', 'the draft survived a failed send');
  await new Promise((resolve) => server.close(resolve));
});

await check('a demo panel signs itself in, a real one never does', async () => {
  const { startPanel } = await import('./panel/server.mjs');

  const demo = await startPanel({ port: 0, host: '127.0.0.1', lanAddress: '127.0.0.1', demo: true });
  const demoBase = `http://127.0.0.1:${demo.address().port}`;
  const demoPing = await (await realFetch(`${demoBase}/api/ping`)).json();
  assert.equal(demoPing.demo, true);
  assert.equal(demoPing.demoToken, 'selftest-token', 'a demo instance hands the page its token');
  assert.equal(demoPing.needsAuth, true, 'it still requires the token: the page signs in with it');
  const auto = await realFetch(`${demoBase}/api/state`, { headers: { Authorization: `Bearer ${demoPing.demoToken}` } });
  assert.equal(auto.status, 200, 'and that token works');
  await new Promise((resolve) => demo.close(resolve));

  const real = await startPanel({ port: 0, host: '127.0.0.1', lanAddress: '127.0.0.1', demo: false });
  const realBase = `http://127.0.0.1:${real.address().port}`;
  const realPing = await (await realFetch(`${realBase}/api/ping`)).json();
  assert.equal(realPing.demo, false);
  assert.equal(realPing.demoToken, undefined, 'a real instance never hands out its token');
  assert.ok(!JSON.stringify(realPing).includes('selftest-token'));
  await new Promise((resolve) => real.close(resolve));
});

await check('a login survives a proxy that eats the request body', async () => {
  // Seen in the wild: the panel log said "wrong token" while the person was typing
  // the right one, because the body never arrived. The token is also accepted as a
  // bearer header, so one of the two copies gets through.
  const { startPanel } = await import('./panel/server.mjs');
  const server = await startPanel({ port: 0, host: '127.0.0.1', lanAddress: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (headers, body) => realFetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });

  const headerOnly = await post({ Authorization: 'Bearer selftest-token' }, '');
  assert.equal(headerOnly.status, 200, 'the header alone is enough');

  const mangledBody = await post({ Authorization: 'Bearer selftest-token' }, JSON.stringify({ token: 'garbled' }));
  assert.equal(mangledBody.status, 200, 'a rewritten body cannot veto a correct header');

  const nothing = await post({}, '');
  assert.equal(nothing.status, 401);
  assert.match((await nothing.json()).error, /no token arrived/, 'the error says the request was empty, not "wrong token"');

  const notAscii = await post({}, JSON.stringify({ token: 'یثمه' }));
  assert.equal(notAscii.status, 401);
  assert.match((await notAscii.json()).error, /keyboard layout/, 'and names a non-ASCII token for what it is');

  const capital = await post({}, JSON.stringify({ token: 'SELFTEST-TOKEN' }));
  assert.equal(capital.status, 401);
  assert.match((await capital.json()).error, /capitalisation/);

  await new Promise((resolve) => server.close(resolve));
});

await check('the login works behind a proxy that rewrites Host', async () => {
  // A hosted preview URL is exactly this: the browser's Origin is the public host,
  // the upstream sees its own Host header. The old check refused the login POST
  // and the panel asked for the token again, forever.
  const { startPanel } = await import('./panel/server.mjs');
  const server = await startPanel({ port: 0, host: '127.0.0.1', lanAddress: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (headers, body) => realFetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  // 1. A browser sends Sec-Fetch-Site: same-origin and pages cannot forge it.
  const sameSite = await post(
    { Origin: 'https://panel.example', Host: '127.0.0.1:8787', 'Sec-Fetch-Site': 'same-origin' },
    { token: 'selftest-token' }
  );
  assert.equal(sameSite.status, 200, 'same-origin request is accepted whatever Host says');
  assert.equal((await sameSite.json()).token, 'selftest-token');

  // 2. A proxy that forwards the public host in X-Forwarded-Host still matches.
  const forwarded = await post(
    { Origin: 'https://panel.example', Host: '127.0.0.1:8787', 'X-Forwarded-Host': 'panel.example' },
    { token: 'selftest-token' }
  );
  assert.equal(forwarded.status, 200);

  // 3. Writes that change something still require a trustworthy origin: the panel
  //    must not be drivable from a hostile page, even with a token-shaped header.
  const write = (headers) => realFetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { Authorization: 'Bearer selftest-token', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ settings: { lang: 'en' } }),
  });
  const hostile = await write({ Origin: 'https://evil.example', Host: '127.0.0.1:8787' });
  assert.equal(hostile.status, 403, 'a hostile page still cannot drive the panel');
  assert.match((await hostile.json()).error, /Cross-origin/);

  // 4. ...but the same write from the panel itself works behind the proxy, which is
  //    what "the page loads, then every Save says 403" would have been next.
  const proxied = await write({ Origin: 'https://panel.example', Host: '127.0.0.1:8787', 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(proxied.status, 200, 'a save from the proxied page is accepted');
  const xfh = await write({ Origin: 'https://panel.example', Host: '127.0.0.1:8787', 'X-Forwarded-Host': 'panel.example' });
  assert.equal(xfh.status, 200, 'or when the proxy forwards the public host');

  // 5. Signing in is decided by the token alone: a wrong one is a 401, not a 403,
  //    whatever the origin looks like.
  const noOriginInfo = await post({ Origin: 'https://elsewhere.example', Host: '127.0.0.1:8787' }, { token: 'wrong' });
  assert.equal(noOriginInfo.status, 401, 'reached the token check instead of the origin check');

  await new Promise((resolve) => server.close(resolve));
});

await check('a correct token works even when the browser keeps no cookie', async () => {
  // The failure this guards: a proxy strips Set-Cookie, so the login succeeds and
  // every request after it is anonymous — the panel says "wrong token" forever.
  const { startPanel } = await import('./panel/server.mjs');
  const server = await startPanel({ port: 0, host: '127.0.0.1', lanAddress: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await realFetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'selftest-token' }),
  });
  assert.equal(login.status, 200);
  const body = await login.json();
  assert.equal(body.token, 'selftest-token', 'the login hands the token back for the header path');

  // No cookie jar here: only the Authorization header, exactly what the page does.
  const state = await realFetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${body.token}` } });
  assert.equal(state.status, 200, 'a bearer header alone is enough');

  // And a wrong token still fails with the reason, not a generic message.
  const wrong = await realFetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'nope' }),
  });
  assert.equal(wrong.status, 401);
  assert.match((await wrong.json()).error, /Wrong token/);
  await new Promise((resolve) => server.close(resolve));
});

await check('login is throttled after repeated wrong tokens', async () => {
  const { startPanel } = await import('./panel/server.mjs');
  const server = await startPanel({ port: 0, host: '127.0.0.1', lanAddress: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;
  let last = 0;
  for (let i = 0; i < 10; i++) {
    const r = await realFetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: `wrong-${i}` }),
    });
    last = r.status;
  }
  assert.equal(last, 429, 'brute force gets locked out');
  const ok = await realFetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'selftest-token' }),
  });
  assert.equal(ok.status, 429, 'even the right token waits out the lockout');
  await new Promise((resolve) => server.close(resolve));
});

const failed = results.filter((r) => !r.ok);
console.log('──────────────────────────────────────────');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name}: ${f.error?.message}`);
  process.exit(1);
}
console.log('State directory:', process.env.BOT_STATE_DIR);
