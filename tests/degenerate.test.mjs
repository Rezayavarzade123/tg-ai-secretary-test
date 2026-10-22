import test from 'node:test';
import assert from 'node:assert/strict';

const { normalise, tokens, analyseAnswer, degenerateReply, correctionNote } = await import('../tgcloud/lib/degenerate.js');
const { matchSmalltalk } = await import('../tgcloud/lib/smalltalk.js');

// ---------------------------------------------------------------- normalising
test('Persian spellings collapse to one form before anything is compared', () => {
  // ZWNJ, Arabic yeh/kaf, harakat and the emoji the model adds: all noise.
  assert.equal(normalise('سیکنتر'), normalise('سیک\u200cنتر'));
  assert.equal(normalise('می‌شناسی'), normalise('ميشناسي'));
  assert.equal(normalise('سلام! 😊'), normalise('سلام'));
  assert.equal(normalise('  Hello,   WORLD. '), 'hello world');
});

// ---------------------------------------------------------------- echo
test('a message handed straight back is an echo', () => {
  const r = analyseAnswer({ answer: 'منو میشناسی؟', userText: 'منو میشناسی؟' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['echo']);
});

test('a multi-word message with the sender\'s words first is an echo', () => {
  const r = analyseAnswer({ answer: 'درست فارسی حرف بزن! باشه', userText: 'درست فارسی حرف بزن' });
  assert.ok(r.reasons.includes('echo'));
});

test('a short answer made only of the sender\'s words is an echo', () => {
  const r = analyseAnswer({ answer: 'فردا جلسه', userText: 'فردا جلسه داری؟' });
  assert.ok(r.reasons.includes('echo'));
});

test('a real answer is not an echo, even when it starts with the greeting', () => {
  // This is the difference that matters: greeting back is fine, greeting back
  // instead of answering is not.
  assert.equal(analyseAnswer({ answer: 'سلام! خوبم، ممنون. چه خبر؟', userText: 'سلام' }).ok, true);
  assert.equal(analyseAnswer({ answer: 'Paris.', userText: 'Capital of France?' }).ok, true);
  assert.equal(analyseAnswer({ answer: "Nice to meet you, Ali.", userText: 'My name is Ali' }).ok, true);
  assert.equal(analyseAnswer({ answer: 'فردا ساعت ۱۰ جلسه داریم.', userText: 'فردا جلسه داری؟' }).ok, true);
});

// ---------------------------------------------------------------- loop
test('the same canned phrase on the next turn is a loop', () => {
  // The real transcript: the sender's word changes, the model's filler does not.
  const r = analyseAnswer({
    answer: 'سیکنتر! ما روی از چی؟',
    userText: 'سیکنتر',
    recentAnswers: ['سلام! ما روی از چی؟'],
  });
  assert.ok(r.reasons.includes('loop'), JSON.stringify(r));
});

test('an identical answer to the previous one is a loop', () => {
  const r = analyseAnswer({ answer: 'I am here.', userText: 'and now?', recentAnswers: ['I am here.'] });
  assert.ok(r.reasons.includes('loop'));
});

test('a genuinely different follow-up is not a loop', () => {
  const r = analyseAnswer({
    answer: 'The meeting is at ten, in the small room.',
    userText: 'where is it?',
    recentAnswers: ['Tomorrow is fine.'],
  });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------- stutter
test('the same sentence twice in one answer is a stutter', () => {
  assert.ok(analyseAnswer({ answer: 'Sure, I can do that. Sure, I can do that.', userText: 'can you' }).reasons.includes('stutter'));
  assert.equal(analyseAnswer({ answer: 'Sure. Then we talk.', userText: 'can you' }).ok, true);
});

test('an empty answer is its own failure, not a pass', () => {
  assert.deepEqual(analyseAnswer({ answer: '   ', userText: 'hi' }).reasons, ['empty']);
});

test('the fallback is in the conversation\'s language, and says what happened', () => {
  assert.match(degenerateReply('en'), /repeating you/);
  assert.match(degenerateReply('fa'), /تکرار/);
  assert.match(degenerateReply('ar'), /أكرر/);
  assert.match(degenerateReply('xx'), /repeating you/, 'an unknown language falls back to English');
  assert.ok(correctionNote().length > 20);
});

// ---------------------------------------------------------------- small talk
test('the sentences from the screenshot are answered from code', () => {
  const fa = { ownerName: 'رضا', lang: 'fa' };
  assert.match(matchSmalltalk('سلام', fa).reply, /دستیار رضا/);
  assert.match(matchSmalltalk('سلام!', fa).reply, /سلام/);
  assert.match(matchSmalltalk('منو میشناسی؟', fa).reply, /شما رضا هستید/);
  assert.match(matchSmalltalk('کی هستی؟', fa).reply, /دستیار/);
  assert.match(matchSmalltalk('ممنون', fa).reply, /خواهش/);
});

test('the same in English, and the name is the owner\'s', () => {
  const en = { ownerName: 'Sam', lang: 'en' };
  assert.match(matchSmalltalk('hello', en).reply, /Sam/);
  assert.match(matchSmalltalk('who are you?', en).reply, /Sam's assistant/);
  assert.match(matchSmalltalk('do you know me?', en).reply, /You're Sam/);
  assert.equal(matchSmalltalk('thanks!', en).id, 'thanks');
});

test('a real request behind a greeting goes to the model', () => {
  // The whole point: matching a greeting must not swallow a question.
  const fa = { ownerName: 'رضا', lang: 'fa' };
  assert.equal(matchSmalltalk('سلام، میشه فردا ساعت پنج جلسه بذاری؟', fa), null);
  assert.equal(matchSmalltalk('سلام خوبی؟', fa).id, 'greeting');
  assert.equal(matchSmalltalk('/panel', fa), null, 'commands are not small talk');
  assert.equal(matchSmalltalk('چطور میتونم تنظیمات پنل رو عوض کنم؟', fa), null);
  assert.equal(matchSmalltalk('What time is my meeting tomorrow with Ali?', { ownerName: 'Sam' }), null);
});

test('an unknown language still answers, in English', () => {
  assert.match(matchSmalltalk('hello', { ownerName: 'Sam', lang: 'xx' }).reply, /Sam/);
});
