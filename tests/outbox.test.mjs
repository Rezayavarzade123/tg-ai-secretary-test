import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from './fake-sdk.mjs';

const { api } = await import('sdk');   // the fake in tests/fake-sdk.mjs
const { parseSendCommand, sendAsOwner, secretaryConnId, SEND_USAGE } = await import('../tgcloud/lib/outbox.js');
const { setSetting, delSetting } = await import('../tgcloud/lib/settings.js');
const { markSeen, updateContact } = await import('../tgcloud/lib/contacts.js');

const people = [
  { chatId: 111, name: 'Ali Rezaei' },
  { chatId: 222, name: 'Ali Tehrani' },
  { chatId: 333, name: 'Sara' },
  { chatId: 444, name: 'Mohammad Hossein Zadeh' },
];

const reset = async () => {
  store.settings = [];
  store.secretary_chats = [];
  store.activity = [];
  delete api.sendMessage;
};

// --- turning a sentence into a target and a message ------------------------------

test('an explicit chat id is taken as is', () => {
  const r = parseSendCommand(people, '222 see you at six');
  assert.equal(r.kind, 'send');
  assert.equal(r.chatId, 222);
  assert.equal(r.name, 'Ali Tehrani', 'the known name is worth echoing back');
  assert.equal(r.text, 'see you at six');
});

test('one word of a name is enough when only one person matches', () => {
  const r = parseSendCommand(people, 'Sara running late');
  assert.equal(r.kind, 'send');
  assert.equal(r.chatId, 333);
  assert.equal(r.text, 'running late');
});

test('the longest matching name wins, so "Ali Reza" beats "Ali"', () => {
  const r = parseSendCommand(people, 'Ali Rezaei on my way');
  assert.equal(r.kind, 'send');
  assert.equal(r.chatId, 111);
  assert.equal(r.text, 'on my way');

  const three = parseSendCommand(people, 'Mohammad Hossein Zadeh hello');
  assert.equal(three.kind, 'send');
  assert.equal(three.chatId, 444);
  assert.equal(three.text, 'hello');
});

test('two people with the same first name is reported, never guessed', () => {
  const r = parseSendCommand(people, 'Ali hello there');
  assert.equal(r.kind, 'many');
  assert.deepEqual(r.people.map((p) => p.chatId).sort(), [111, 222]);
});

test('an unknown name is a refusal, and says what it knows', () => {
  const r = parseSendCommand(people, 'Nima call me');
  assert.equal(r.kind, 'none');
  assert.equal(r.query, 'Nima');
});

test('a half-typed command is usage, not an unknown person', () => {
  assert.equal(parseSendCommand(people, '').kind, 'usage');
  assert.equal(parseSendCommand(people, '   ').kind, 'usage');
  assert.equal(parseSendCommand(people, 'Sara').kind, 'usage');
  assert.equal(parseSendCommand(people, '222').kind, 'usage');
  assert.match(SEND_USAGE, /\/send <name or chat id> <text>/);
});

test('a quoted name keeps its spaces, for names the matcher cannot split', () => {
  const r = parseSendCommand(people, '"Mohammad Hossein Zadeh" hello there');
  assert.equal(r.kind, 'send');
  assert.equal(r.chatId, 444);
  assert.equal(r.text, 'hello there');
});

test('the text keeps its own punctuation and line breaks', () => {
  const r = parseSendCommand(people, 'Sara hi! how are you?');
  assert.equal(r.text, 'hi! how are you?');
  const multi = parseSendCommand(people, 'Sara line one\nline two');
  assert.equal(multi.text, 'line one\nline two');
});

// --- actually sending ------------------------------------------------------------

const capture = () => {
  const sent = [];
  api.sendMessage = async (p) => { sent.push(p); return { message_id: sent.length }; };
  return sent;
};

test('a message goes out from the account, through the business connection', async () => {
  await reset();
  await setSetting('secretary_conns', JSON.stringify(['conn-1']));
  await markSeen(111, 'Ali Rezaei');
  const sent = capture();

  const r = await sendAsOwner(111, 'running 10 minutes late');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, 111);
  assert.equal(sent[0].text, 'running 10 minutes late');
  assert.equal(sent[0].business_connection_id, 'conn-1', 'otherwise it would come from the bot, not from you');
  assert.equal(r.text, 'running 10 minutes late');
  assert.deepEqual(r.reasons, []);
});

test('without a connection it refuses and says where to make one', async () => {
  await reset();
  const sent = capture();
  await assert.rejects(() => sendAsOwner(111, 'hello'), /Business|connection/i);
  assert.equal(sent.length, 0, 'nothing may be attempted without a connection');
  assert.equal(await secretaryConnId(), null);
});

test('a blocked person is not written to, even when you ask directly', async () => {
  await reset();
  await setSetting('secretary_conns', JSON.stringify(['conn-1']));
  await markSeen(333, 'Sara');
  await updateContact(333, { blocked: true });
  const sent = capture();

  await assert.rejects(() => sendAsOwner(333, 'hello'), /blocked/i);
  assert.equal(sent.length, 0);
});

test('the guards still run, and a rewrite is reported instead of hidden', async () => {
  await reset();
  await setSetting('secretary_conns', JSON.stringify(['conn-1']));
  await setSetting('owner_name', 'Reza');
  await markSeen(111, 'Ali Rezaei');
  const sent = capture();

  const r = await sendAsOwner(111, 'I am Reza, who is this?');

  assert.equal(sent.length, 1);
  assert.notEqual(sent[0].text, 'I am Reza, who is this?', 'the identity guard must rewrite it');
  assert.ok(r.reasons.length > 0);
  assert.equal(r.replaced, true);
  assert.equal(sent[0].text, r.text, 'the owner is shown exactly what was sent');
});

test('an empty message never reaches Telegram', async () => {
  await reset();
  await setSetting('secretary_conns', JSON.stringify(['conn-1']));
  const sent = capture();
  await assert.rejects(() => sendAsOwner(111, '   '), /nothing to send/i);
  assert.equal(sent.length, 0);
  await delSetting('secretary_conns');
});
