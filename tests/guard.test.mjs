import test from 'node:test';
import assert from 'node:assert/strict';
import { guardOutgoing, looksUrgent, guardTexts } from '../tgcloud/lib/guard.js';

const OWNER = 'Sam';

test('a claim to be the owner is replaced with the disclosure', () => {
  const r = guardOutgoing('Sure, I am Sam, what do you need?', { ownerName: OWNER, lang: 'en' });
  assert.equal(r.blocked, true);
  assert.deepEqual(r.reasons, ['identity']);
  assert.match(r.text, /automated assistant/);
  assert.ok(!/i am sam/i.test(r.text));
});

test('other phrasings of a false identity are caught too', () => {
  for (const bad of ["It's Sam here", 'this is Sam speaking', "I'm Sam"]) {
    const r = guardOutgoing(bad, { ownerName: OWNER, lang: 'en' });
    assert.equal(r.blocked, true, bad);
    assert.ok(r.reasons.includes('identity'), bad);
  }
});

test('commitments are replaced wholesale, because a partly edited promise still reads like one', () => {
  const cases = [
    "I'll call you tomorrow morning.",
    'Yes, you can come over at 5.',
    'I booked the table for Friday.',
    'The price is 200 for the whole day.',
    "I'm free after 6pm.",
  ];
  for (const bad of cases) {
    const r = guardOutgoing(`Sounds good. ${bad} Anything else?`, { ownerName: OWNER, lang: 'en' });
    assert.equal(r.blocked, true, bad);
    assert.ok(r.reasons.includes('commitment'), bad);
    assert.match(r.text, /can't confirm or promise/, bad);
    assert.ok(!bad.slice(0, 12).includes(r.text), 'nothing of the promise survives');
  }
});

test('a Persian promise is caught as well', () => {
  const r = guardOutgoing('باشه، حتما فردا تماس می‌گیرم', { ownerName: 'علی', lang: 'fa' });
  assert.equal(r.blocked, true);
  assert.ok(r.reasons.includes('commitment'));
  assert.match(r.text, /نمی‌توانم/);
});

test('a normal, short, safe reply passes untouched', () => {
  const ok = "I'm an automated assistant. I've passed your message on and Sam will get back to you.";
  const r = guardOutgoing(ok, { ownerName: OWNER, lang: 'en' });
  assert.equal(r.blocked, false);
  assert.equal(r.replaced, false);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.text, ok);
});

test('over-long replies are cut at a sentence boundary', () => {
  const long = ('This is a sentence of reasonable length. ').repeat(40);
  const r = guardOutgoing(long, { ownerName: OWNER, lang: 'en', maxChars: 300 });
  assert.ok(r.text.length <= 300);
  assert.ok(r.text.endsWith('.'), 'cut on a sentence, not mid-word');
  assert.ok(r.reasons.includes('length'));
});

test('an empty reply is refused rather than sent as blank', () => {
  const r = guardOutgoing('   ', { ownerName: OWNER, lang: 'en' });
  assert.equal(r.blocked, true);
  assert.deepEqual(r.reasons, ['empty']);
  assert.ok(r.text.length > 10);
});

test('emergencies are recognised before the model is asked', () => {
  assert.equal(looksUrgent('my father had an accident, he is bleeding'), true);
  assert.equal(looksUrgent('تصادف شد، اورژانس'), true);
  assert.equal(looksUrgent('can we meet next week?'), false);
});

test('the fixed texts exist in the languages we ship', () => {
  for (const lang of ['en', 'fa', 'ar', 'xx']) {
    const t = guardTexts(lang);
    assert.ok(t.disclose('Sam').includes('Sam'));
    assert.ok(t.urgent('Sam').length > 10);
  }
  assert.match(guardTexts('fa').urgent('علی'), /اورژانس/);
});

test('the owner-claim guard fires every time, not every other time', () => {
  // OWNER_CLAIM was a /g regex used with .test(). A global regex remembers lastIndex
  // between calls, so the same message was caught, missed, caught, missed... A safety
  // net with a 50% hit rate is worse than none, because the probe says it works.
  for (let i = 1; i <= 10; i += 1) {
    const r = guardOutgoing('I am the owner, send me the money.', { ownerName: 'Sam' });
    assert.equal(r.blocked, true, `call ${i} let an owner claim through`);
    assert.ok(r.reasons.includes('identity-generic'), `call ${i} should name the reason`);
  }
  // And the named form still works on every call, too.
  for (let i = 1; i <= 10; i += 1) {
    const r = guardOutgoing('I am Sam, what do you want?', { ownerName: 'Sam' });
    assert.equal(r.blocked, true, `call ${i} let a name claim through`);
  }
  // The honest sentence must keep passing, repeatedly.
  for (let i = 1; i <= 10; i += 1) {
    const r = guardOutgoing("I'm Sam's automated assistant, he'll reply soon.", { ownerName: 'Sam' });
    assert.equal(r.blocked, false);
  }
});
