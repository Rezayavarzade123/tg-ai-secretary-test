import test from 'node:test';
import assert from 'node:assert/strict';

import {
  article, placeholderResult, answerResults, errorResult,
} from '../tgcloud/handlers/inline_query.js';

// Inline mode is how the bot helps in a group it is not even a member of: the
// owner types "@bot question" anywhere, the answer appears in the result list, and
// nothing is sent until they pick it. These tests cover the payload shapes and
// the two rules that keep it safe on a slow CPU (owner only, one model call per
// burst) — the handler's timing behaviour is exercised in the self test.

test('an answer result is pressable text, not a bot message', () => {
  const [result] = answerResults('Thursday works. I will be there at 10.');
  assert.equal(result.type, 'article');
  assert.equal(result.input_message_content.message_text, 'Thursday works. I will be there at 10.');
  assert.match(result.description, /Thursday works/);
});

test('a very long answer is cut to what Telegram accepts', () => {
  const long = 'x'.repeat(5000);
  const [result] = answerResults(long);
  assert.equal(result.input_message_content.message_text.length, 4000);
});

test('the placeholder says what is happening instead of pretending to answer', () => {
  const [result] = placeholderResult('are we still on for thursday');
  assert.equal(result.id, 'thinking');
  assert.equal(result.title, 'Thinking…');
  assert.match(result.description, /are we still on for thursday/);
  assert.match(result.input_message_content.message_text, /Still thinking/);
});

test('a failure is shown as a failure', () => {
  const [result] = errorResult('The model did not answer within 25 s.');
  assert.match(result.input_message_content.message_text, /^⚠️/);
  assert.match(result.description, /25 s/);
});

test('result ids are stable, so a second answer replaces the first', () => {
  // Telegram replaces the result list when answerInlineQuery is called again with
  // the same query id; stable ids keep the client from showing duplicates.
  assert.equal(article('answer', 'a', 'b', 'c').id, 'answer');
  assert.equal(answerResults('one')[0].id, answerResults('two')[0].id);
});

test('the payload carries no unsupported characters or empty fields', () => {
  const json = JSON.stringify(answerResults('ok'));
  assert.ok(!json.includes('undefined'));
  assert.ok(!json.includes('null'));
});
