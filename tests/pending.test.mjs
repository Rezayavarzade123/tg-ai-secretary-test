import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from './fake-sdk.mjs';
import { queueFragment, claimBatch, clearPending } from '../tgcloud/lib/pending.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirrors what handlers/business_message.js (Secretary mode) does for one incoming fragment.
async function handle(chatId, text, delayMs, answers) {
  const id = await queueFragment({ chatId, connId: 'c1', name: 'x', text });
  await sleep(delayMs);
  const batch = await claimBatch(chatId, id);
  if (batch) answers.push({ chatId, text: batch.text, count: batch.count });
}

test('a burst is answered once, merged; other people are independent', async () => {
  store.pending = [];
  const answers = [];
  const DELAY = 120;

  await Promise.all([
    handle(1, 'a1', DELAY, answers),                                  // t=0
    sleep(15).then(() => handle(2, 'b1', DELAY, answers)),            // other person, t=15
    sleep(30).then(() => handle(1, 'a2', DELAY, answers)),            // t=30 restarts A's timer only
    sleep(60).then(() => handle(1, 'a3', DELAY, answers)),            // t=60
  ]);

  assert.equal(answers.length, 2, 'exactly one answer per person');
  const a = answers.find((x) => x.chatId === 1);
  const b = answers.find((x) => x.chatId === 2);
  assert.equal(a.text, 'a1\na2\na3');
  assert.equal(a.count, 3);
  assert.equal(b.text, 'b1');
  assert.equal(b.count, 1);
  assert.equal(answers[0].chatId, 2, 'B (quiet sooner) is answered first, not held up by A');
  assert.equal(store.pending.length, 0, 'queue is empty afterwards');
});

test('a second round after the answer starts a fresh batch', async () => {
  store.pending = [];
  const answers = [];
  await handle(1, 'first', 30, answers);
  await handle(1, 'second', 30, answers);
  assert.deepEqual(answers.map((x) => x.text), ['first', 'second']);
});

test('stale fragments are dropped, clearPending empties one chat only', async () => {
  store.pending = [
    { id: -1, chatId: 5, connId: 'c', name: 'x', text: 'ancient', at: Math.floor(Date.now() / 1000) - 3600 },
  ];
  const id = await queueFragment({ chatId: 5, connId: 'c', name: 'x', text: 'fresh' });
  const batch = await claimBatch(5, id);
  assert.equal(batch.text, 'fresh');

  await queueFragment({ chatId: 7, connId: 'c', name: 'x', text: 'keep' });
  await queueFragment({ chatId: 8, connId: 'c', name: 'x', text: 'drop' });
  await clearPending(8);
  assert.deepEqual(store.pending.map((r) => r.chatId), [7]);
});
