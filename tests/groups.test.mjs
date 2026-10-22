import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isGroupChat, addressesBot, stripAddress, historyScope, threadExtra,
} from '../tgcloud/lib/groups.js';

// Being in a group is the easy part; the hard part is knowing when a message is
// for the bot. Everything here is pure, so the rules can be read and tested
// without Telegram.

const ME = { id: 42, username: 'secretary_bot' };
const msg = (over = {}) => ({ chat: { id: -100, type: 'supergroup' }, from: { id: 7 }, text: '', ...over });

test('only real group types count as groups', () => {
  assert.equal(isGroupChat('group'), true);
  assert.equal(isGroupChat('supergroup'), true);
  assert.equal(isGroupChat('private'), false);
  assert.equal(isGroupChat('channel'), false);
  assert.equal(isGroupChat(undefined), false);
});

test('a plain group message is not for the bot', () => {
  assert.equal(addressesBot(msg({ text: 'does anyone know the plan for Friday?' }), ME), false);
  assert.equal(addressesBot(msg({ text: '/mode off' }), ME), false, 'another bot\'s command is not ours');
  assert.equal(addressesBot(msg({ text: '' }), ME), false);
});

test('a mention addresses the bot, with or without an entity', () => {
  const withEntity = msg({
    text: '@secretary_bot what is the plan?',
    entities: [{ type: 'mention', offset: 0, length: 14 }],
  });
  assert.equal(addressesBot(withEntity, ME), true);

  // Some clients do not send the entity; the plain text still counts.
  assert.equal(addressesBot(msg({ text: 'hey @Secretary_Bot, are you there?' }), ME), true);
  assert.equal(addressesBot(msg({ text: 'mail me at bob@secretary_bot.example' }), ME), false, 'not a mention inside a word');
});

test('a mention of a different bot is not ours', () => {
  const other = msg({
    text: '@other_bot hello',
    entities: [{ type: 'mention', offset: 0, length: 10 }],
  });
  assert.equal(addressesBot(other, ME), false);
});

test('replying to one of the bot\'s messages addresses it', () => {
  assert.equal(addressesBot(msg({ text: 'and then?', reply_to_message: { from: { id: 42 } } }), ME), true);
  assert.equal(addressesBot(msg({ text: 'and then?', reply_to_message: { from: { id: 9 } } }), ME), false);
});

test('/command@botname addresses it; /command does not', () => {
  assert.equal(addressesBot(msg({ text: '/status@secretary_bot' }), ME), true);
  assert.equal(addressesBot(msg({ text: '/status' }), ME), false);
});

test('a bot mentioned without a username is caught by the entity user id', () => {
  const bare = msg({
    text: 'the secretary should know',
    entities: [{ type: 'text_mention', offset: 0, length: 13, user: { id: 42 } }],
  });
  assert.equal(addressesBot(bare, ME), true);
});

test('an unknown identity never matches anything', () => {
  assert.equal(addressesBot(msg({ text: '@secretary_bot hi', entities: [] }), { id: 0, username: '' }), false);
});

test('the mention is stripped before the model sees it', () => {
  assert.equal(stripAddress('@secretary_bot what is the plan?', ME), 'what is the plan?');
  assert.equal(stripAddress('hey @secretary_bot  are you there?', ME), 'hey are you there?');
  assert.equal(stripAddress('@Secretary_Bot', ME), '');
  assert.equal(stripAddress('no mention here', ME), 'no mention here');
});

test('each group gets its own memory', () => {
  assert.equal(historyScope({ id: -1001, type: 'supergroup' }), 'group:-1001');
  assert.equal(historyScope({ id: 5, type: 'group' }), 'group:5');
  assert.equal(historyScope({ id: 1234, type: 'private' }), 'bot', 'the private chat keeps the shared scope');
});

test('a forum topic reply stays in its thread', () => {
  assert.deepEqual(threadExtra({ is_topic_message: true, message_thread_id: 9 }), { message_thread_id: 9 });
  assert.deepEqual(threadExtra({ is_topic_message: true }), {});
  assert.deepEqual(threadExtra({ message_thread_id: 9 }), {}, 'no topic flag, no thread');
  assert.deepEqual(threadExtra(undefined), {});
});
