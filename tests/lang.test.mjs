import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLang, isLanguage, isLanguageInput, resolveLanguage, languageLine, resolveLang,
  languagePromptName, LANGUAGES,
} from '../tgcloud/lib/lang.js';

test('detects the script of a message', () => {
  assert.equal(detectLang('سلام، خوبی؟'), 'fa');
  assert.equal(detectLang('Привет, как дела?'), 'ru');
  assert.equal(detectLang('你好，你好吗'), 'zh');
  assert.equal(detectLang('こんにちは、元気ですか'), 'ja');
  assert.equal(detectLang('안녕하세요'), 'ko');
  assert.equal(detectLang('مرحبا كيف حالك'), 'ar');
  assert.equal(detectLang('नमस्ते कैसे हैं आप'), 'hi');
});

test('detects Latin languages by stop-words, and gives up on noise', () => {
  assert.equal(detectLang('Hi, are you there? I wanted to ask what time it is'), 'en');
  assert.equal(detectLang('Hallo, ich bin nicht sicher und du?'), 'de');
  assert.equal(detectLang('Bonjour, je ne suis pas disponible pour le moment'), 'fr');
  assert.equal(detectLang('Hola, ¿estás en casa? Yo no puedo ir'), 'es');
  assert.equal(detectLang('ok'), null);
  assert.equal(detectLang('123'), null);
  assert.equal(detectLang(''), null);
});

test('Persian vs Arabic share a script and are told apart by their own letters', () => {
  assert.equal(detectLang('چطوری؟'), 'fa');        // چ / ی are Persian
  assert.equal(detectLang('كيف حالك'), 'ar');       // ك is Arabic
});

test('resolveLang prefers a language it recognises, then the setting', () => {
  assert.equal(resolveLang('en', 'Привет'), 'ru');
  assert.equal(resolveLang('de', 'ok'), 'de', 'one word proves nothing, so the setting wins');
  assert.equal(resolveLang('nonsense', 'ok'), 'en');
});

test('an undetected Latin sentence is English, not the owner\'s default', () => {
  // From a real transcript: a Persian-default bot answering English speakers with
  // "I am an automated assistant and cannot talk in English". detectLang() needs two
  // stop-word hits for a Latin language, so these came back null and fell through to
  // the Persian default - which the model then turned into that sentence.
  assert.equal(detectLang('Change your settings so you can'), null, 'the detection really is unsure');
  assert.equal(resolveLang('fa', 'Change your settings so you can'), 'en');
  assert.equal(resolveLang('fa', "He'll be awaiting for you"), 'en');
  assert.equal(resolveLang('fa', 'Hello talk English'), 'en');
  // Persian is still obvious when it is Persian, and a single word still defers.
  assert.equal(resolveLang('fa', 'سلام خوبی'), 'fa');
  assert.equal(resolveLang('fa', 'Fucker'), 'fa');
  assert.equal(resolveLang('fa', '؟'), 'fa');
});

test('a Latin setting is not overridden by the English guess', () => {
  // Swedish written without any of the stop-words the detector knows: the honest
  // answer is the owner's setting, not English.
  assert.equal(detectLang('Vi ses imorgon klockan tre'), null);
  assert.equal(resolveLang('sv', 'Vi ses imorgon klockan tre'), 'sv');
  assert.equal(resolveLang('de', 'Kann morgen leider nicht kommen'), 'de');
  // The v1.7.4 fix still holds: a non-Latin setting cannot answer a Latin message.
  assert.equal(resolveLang('fa', 'Please call me tomorrow'), 'en');
  assert.equal(resolveLang('ru', 'Please call me tomorrow'), 'en');
  // A language this build has never heard of keeps the benefit of the doubt.
  assert.equal(resolveLang('tlh', 'nuqneH tera'), 'tlh');
});

test('languageLine enforces a fixed language or follows the sender', () => {
  assert.match(languageLine({ lang: 'fa', auto: true }), /language of the person's latest message/);
  assert.match(languageLine({ lang: 'fa', auto: true }), /Persian/);
  const fixed = languageLine({ lang: 'fa', auto: false });
  assert.match(fixed, /always reply in Persian \(Farsi\)/);
  assert.match(fixed, /Do not switch/);
});

test('the language registry is coherent', () => {
  assert.ok(LANGUAGES.length >= 8);
  for (const l of LANGUAGES) {
    assert.ok(isLanguage(l.code), `${l.code} should be valid`);
    assert.ok(l.prompt && l.native && l.label);
    assert.ok(['ltr', 'rtl'].includes(l.dir));
  }
  assert.ok(LANGUAGES.some((l) => l.dir === 'rtl'));
  assert.equal(languagePromptName('fa'), 'Persian (Farsi)');
  assert.equal(languagePromptName('xx'), 'xx');
});

test('any language can be chosen, not only the ones in the registry', () => {
  // The registry is a convenience list of names, never a whitelist.
  assert.equal(resolveLanguage('Swedish').code, 'sv');
  assert.equal(resolveLanguage('sv').code, 'sv');
  assert.equal(resolveLanguage('sv-SE').code, 'sv');
  assert.equal(resolveLanguage('Svenska').code, 'sv');
  assert.equal(resolveLanguage('فارسی').code, 'fa');

  const unknown = resolveLanguage('tlh');
  assert.equal(unknown.code, 'tlh');
  assert.equal(unknown.known, false);
  assert.equal(unknown.prompt, 'tlh');

  // Said as a word rather than a code: passed to the model as written.
  const named = resolveLanguage('Klingon');
  assert.equal(named.known, false);
  assert.equal(named.prompt, 'Klingon');

  // The prompt name is whatever was asked for, so the model is never told a
  // language it did not get.
  assert.equal(languagePromptName('tlh'), 'tlh');
  assert.equal(languagePromptName('Swedish'), 'Swedish');

  const line = languageLine({ lang: 'tlh', auto: false });
  assert.match(line, /always reply in tlh/);
});

test('input that is not a language is still rejected', () => {
  assert.equal(isLanguageInput('sv'), true);
  assert.equal(isLanguageInput('Swedish'), true);
  assert.equal(isLanguageInput(''), false);
  assert.equal(isLanguageInput('   '), false);
  assert.equal(isLanguageInput('x'.repeat(41)), false);
  // Not letters, digits, space, underscore or hyphen.
  assert.equal(isLanguageInput('a b c!'), false);
  assert.equal(isLanguageInput('<script>'), false);
});

test('a widened script table still answers the common ones correctly', () => {
  assert.equal(detectLang('Cześć, jak się masz?'), 'pl');
  assert.equal(detectLang('Hej, hur är det?'), 'sv');
  assert.equal(detectLang('Привіт, як справи?'), 'uk');
  assert.equal(detectLang('آپ کیسے ہیں؟'), 'ur');
  assert.equal(detectLang('Xin chào bạn'), 'vi');
  assert.equal(detectLang('สวัสดีครับ'), 'th');
  assert.equal(detectLang('שלום מה שלומך'), 'he');
});
