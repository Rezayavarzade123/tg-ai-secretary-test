import test from 'node:test';
import assert from 'node:assert/strict';

const { normalise, tokens, analyseAnswer, degenerateReply, correctionNote } = await import('../tgcloud/lib/degenerate.js');
const { matchSmalltalk } = await import('../tgcloud/lib/smalltalk.js');
const { guardTexts, hasSafetyTexts } = await import('../tgcloud/lib/guard.js');

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
  // "hi, are you well?" is a greeting *and* a question about me, so it gets the
  // answer to the question rather than the plain hello.
  assert.equal(matchSmalltalk('سلام خوبی؟', fa).id, 'howAreYou');
  assert.equal(matchSmalltalk('/panel', fa), null, 'commands are not small talk');
  assert.equal(matchSmalltalk('چطور میتونم تنظیمات پنل رو عوض کنم؟', fa), null);
  assert.equal(matchSmalltalk('What time is my meeting tomorrow with Ali?', { ownerName: 'Sam' }), null);
  // Widened greetings must not widen what gets swallowed: a greeting plus a real
  // request is still a request, and a thank-you with a favour attached is a favour.
  assert.equal(matchSmalltalk('hey, are you free tomorrow at 5?', { ownerName: 'Sam' }), null);
  assert.equal(matchSmalltalk('thanks, can you send the file?', { ownerName: 'Sam' }), null);
  // ...while the ordinary ways of saying hello still count.
  assert.equal(matchSmalltalk('hi there', { ownerName: 'Sam' }).id, 'greeting');
  assert.equal(matchSmalltalk('hello again!', { ownerName: 'Sam' }).id, 'greeting');
});

test('the guard and the apology follow a language stored as a name', () => {
  // An older build stored the typed value, so these arrive as "Swedish" rather than
  // "sv". English there would have been a silent downgrade.
  assert.match(guardTexts('Swedish').disclose('Sam'), /automatiska assistent/);
  assert.match(degenerateReply('Swedish'), /Mitt svar blev fel/);
  assert.equal(hasSafetyTexts('Swedish'), true);
  // A language with no table falls back to English, and says so.
  assert.equal(hasSafetyTexts('tlh'), false);
  assert.match(guardTexts('tlh').disclose('Sam'), /automated assistant/);
});

test('a language this file cannot write is left to the model, on purpose', () => {
  // Answering in English a Swedish speaker who said "hej" would be worse than
  // letting the model answer - and the repetition checks still apply to its reply.
  assert.equal(matchSmalltalk('hej', { ownerName: 'Sam', lang: 'sv' }), null);
  assert.equal(matchSmalltalk('hello', { ownerName: 'Sam', lang: 'tlh' }), null);
  // The same greeting is answered by code where the words exist.
  assert.match(matchSmalltalk('hola', { ownerName: 'Sam', lang: 'es' }).reply, /Sam/);
  assert.match(matchSmalltalk('hallo', { ownerName: 'Sam', lang: 'de' }).reply, /Sam/);
  assert.match(matchSmalltalk('привет', { ownerName: 'Sam', lang: 'ru' }).reply, /Sam/);
  assert.match(matchSmalltalk('merhaba', { ownerName: 'Sam', lang: 'tr' }).reply, /Sam/);
});
