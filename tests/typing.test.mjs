import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './fake-sdk.mjs';
import { withTyping } from '../tgcloud/lib/telegram.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('typing is repeated while the work runs, carries the secretary connection id, and stops afterwards', async () => {
  const calls = [];
  api.sendChatAction = async (p) => { calls.push(p); };

  const result = await withTyping(42, 'conn-1', async () => { await sleep(130); return 'answer'; }, 30);
  assert.equal(result, 'answer');
  assert.ok(calls.length >= 4, `expected several refreshes, got ${calls.length}`);
  assert.ok(calls.every((c) => c.chat_id === 42 && c.action === 'typing' && c.business_connection_id === 'conn-1'));

  const after = calls.length;
  await sleep(100);
  assert.equal(calls.length, after, 'no more typing after the work finished');
});

test('private chats with the bot send no business_connection_id', async () => {
  const calls = [];
  api.sendChatAction = async (p) => { calls.push(p); };
  await withTyping(7, null, async () => { await sleep(10); }, 30);
  assert.ok(calls.length >= 1);
  assert.ok(!('business_connection_id' in calls[0]));
});

test('a failing work stops the indicator and rethrows; a failing indicator never breaks the work', async () => {
  const calls = [];
  api.sendChatAction = async (p) => { calls.push(p); };
  await assert.rejects(withTyping(1, null, async () => { await sleep(40); throw new Error('model down'); }, 15), /model down/);
  const after = calls.length;
  await sleep(60);
  assert.equal(calls.length, after, 'interval cleared after failure');

  api.sendChatAction = async () => { throw new Error('telegram hiccup'); };
  assert.equal(await withTyping(1, null, async () => { await sleep(40); return 'still fine'; }, 15), 'still fine');
});
