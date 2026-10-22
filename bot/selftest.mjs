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
    if (method === 'getMe') return tg({ id: 42, username: 'selftest_bot', first_name: 'Secretary' });
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
  await botMessage({ message_id: 12, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Sam' }, text: '/mode auto' });
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

await check('the control panel answers with live state', async () => {
  const { startPanel } = await import('./panel/server.mjs');
  const server = await startPanel({ port: 0, host: '127.0.0.1', lanAddress: '127.0.0.1' });
  const port = server.address().port;

  const unauth = await realFetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(unauth.status, 401, 'no token, no data');

  const ping = await (await realFetch(`http://127.0.0.1:${port}/api/ping`)).json();
  assert.equal(ping.needsAuth, true);

  const stateRes = await realFetch(`http://127.0.0.1:${port}/api/state`, {
    headers: { Authorization: 'Bearer selftest-token' },
  });
  assert.equal(stateRes.status, 200);
  const state = await stateRes.json();
  assert.equal(state.owner.id, OWNER);
  assert.equal(state.bot.username, 'selftest_bot');
  assert.ok(state.draftsPending >= 1, 'the panel sees the waiting draft');

  // Settings written by the panel are the same rows the handlers read.
  const saveRes = await realFetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer selftest-token' },
    body: JSON.stringify({ settings: { delay_seconds: 25, lang: 'fa' } }),
  });
  assert.equal(saveRes.status, 200);
  assert.equal(await getSetting('delay_seconds'), '25');
  assert.equal(await getSetting('lang'), 'fa');

  // A rejected setting leaves the old value alone.
  const badRes = await realFetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer selftest-token' },
    body: JSON.stringify({ settings: { lang: 'klingon' } }),
  });
  assert.equal(badRes.status, 400, 'a bad value is a client error, not a crash');
  assert.equal(await getSetting('lang'), 'fa');

  const page = await (await realFetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(page, /control panel/i);

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
