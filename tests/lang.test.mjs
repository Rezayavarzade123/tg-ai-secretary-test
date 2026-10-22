import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLang, isLanguage, languageLine, resolveLang, languagePromptName, LANGUAGES } from '../tgcloud/lib/lang.js';

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
  assert.equal(resolveLang('de', 'ok'), 'de');
  assert.equal(resolveLang('nonsense', 'ok'), 'en');
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
