import test from 'node:test';
import assert from 'node:assert/strict';
import { chunk, parseCommand, stripThink, displayName, errMsg, fillPrompt } from '../tgcloud/lib/text.js';

test('fillPrompt replaces every {owner} and leaves other braces alone', () => {
  assert.equal(fillPrompt('You are {owner}\'s aide. Ask {owner} first. {other}', 'Sam'), "You are Sam's aide. Ask Sam first. {other}");
  assert.equal(fillPrompt(null, 'Sam'), '');
});

test('parseCommand keeps a multi-line /prompt body intact', () => {
  const r = parseCommand('/prompt secretary You are {owner}\'s assistant.\nBe formal.\n\nShort replies.');
  assert.equal(r.cmd, 'prompt');
  assert.equal(r.arg, "secretary You are {owner}'s assistant.\nBe formal.\n\nShort replies.");
});

test('parseCommand handles args, bot suffix and non-commands', () => {
  assert.deepEqual(parseCommand('/remember buy milk'), { cmd: 'remember', arg: 'buy milk' });
  assert.deepEqual(parseCommand('/Secretary@MySecretaryBot on'), { cmd: 'secretary', arg: 'on' });
  assert.deepEqual(parseCommand('/secretaryinfo Open 9-17'), { cmd: 'secretaryinfo', arg: 'Open 9-17' });
  assert.deepEqual(parseCommand('/notes'), { cmd: 'notes', arg: '' });
  assert.deepEqual(parseCommand('/persona line one\nline two'), { cmd: 'persona', arg: 'line one\nline two' });
  assert.equal(parseCommand('hello /notes'), null);
  assert.equal(parseCommand(''), null);
});

test('chunk keeps every piece under the limit and loses no words', () => {
  const para = 'word '.repeat(300).trim();
  const long = [para, para, para, para].join('\n\n');
  const parts = chunk(long, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 1000);
  assert.equal(parts.join(' ').split(/\s+/).length, long.split(/\s+/).length);
});

test('chunk handles an unbroken string and short text', () => {
  const parts = chunk('x'.repeat(2500), 1000);
  assert.deepEqual(parts.map((p) => p.length), [1000, 1000, 500]);
  assert.deepEqual(chunk('hi'), ['hi']);
  assert.deepEqual(chunk(''), []);
});

test('stripThink removes reasoning blocks', () => {
  assert.equal(stripThink('<think>hmm\nmore</think>\nAnswer'), 'Answer');
  assert.equal(stripThink(null), '');
});

test('displayName and errMsg fall back sensibly', () => {
  assert.equal(displayName({ first_name: 'Ann', last_name: 'Lee' }), 'Ann Lee');
  assert.equal(displayName({ id: 7, username: 'ann' }), 'ann');
  assert.equal(displayName({ id: 7 }), '7');
  assert.equal(errMsg({ description: 'bad' }), 'bad');
  assert.equal(errMsg(new Error('boom')), 'boom');
});
