// Detecting the ways a 1–2B model fails without failing loudly.
//
// The failure this exists for, seen on a real Windows box with a 1.7B model:
//
//   you: سلام                 bot: سلام! 😊 ما روی از چی؟
//   you: درست فارسی حرف بزن    bot: سلام! 😊 ما روی از چی؟
//   you: سیکنتر               bot: سیکنتر! 😊 ما روی از چی؟
//   you: منو میشناسی؟          bot: منو میشناسی؟
//
// Three different failures, none of them an error: an echo, a canned phrase that
// came back identically on the next turn, and a message repeated word for word.
// All three can be recognised from the text alone, without knowing what the model
// meant, and all three get better by trying again or by answering from code.

// Persian/Arabic text arrives in several spellings; compare the meaning-bearing
// shape instead of the bytes. Same table the language detector uses.
const ZWNJ = /\u200c/g;
const DIACRITICS = /[\u064B-\u065F\u0670\u0640]/g;   // harakat and tatweel

export function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(ZWNJ, '')
    .replace(DIACRITICS, '')
    .replace(/[يﻯ]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/[ةۀ]/g, 'ه')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ؤ]/g, 'و')
    .replace(/[ئ]/g, 'ی')
    // Emoji, punctuation and digits-to-nothing: "سیکنتر! 😊" and "سیکنتر" are the same word.
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function tokens(text) {
  const n = normalise(text);
  return n ? n.split(' ') : [];
}

const sentences = (text) => String(text ?? '')
  .split(/[.!?؟\n]+/)
  .map((s) => normalise(s))
  .filter((s) => s.length >= 4);

// The answer added no words of its own: everything in it came from the question.
function isEcho(answer, userText) {
  const a = normalise(answer);
  const u = normalise(userText);
  if (!a || !u) return false;
  if (a === u) return true;

  const at = tokens(answer);
  const ut = new Set(tokens(userText));
  if (!at.length || !ut.size) return false;

  // A whole multi-word message handed back with the sender's own words first.
  if (u.split(' ').length >= 2 && a.startsWith(`${u} `)) return true;
  if (u.split(' ').length >= 2 && a.startsWith(u) && u.length >= 8) return true;

  // A short answer made only of words from the question ("منو میشناسی؟" -> "منو میشناسی").
  const newWords = at.filter((w) => !ut.has(w) && w.length > 1);
  return at.length >= 2 && newWords.length === 0;
}

// The same canned phrase, possibly wearing the sender's words as a hat:
// "سلام! ما روی از چی؟" then "سیکنتر! ما روی از چی؟" is one failure, not two.
function isLoop(answer, recentAnswers) {
  const a = normalise(answer);
  if (!a) return false;
  for (const prev of recentAnswers) {
    if (normalise(prev) === a) return true;
  }
  // Compare what is left after removing words the two answers share with the
  // question - that is the part the model made up on its own.
  const at = new Set(tokens(answer));
  for (const prev of recentAnswers) {
    const pt = tokens(prev);
    if (pt.length < 3) continue;
    const shared = [...at].filter((w) => pt.includes(w)).length;
    if (shared / Math.max(at.size, pt.length) >= 0.75 && at.size >= 3) return true;
  }
  return false;
}

// "I am an automated assistant and I cannot answer in English."
//
// From a real transcript, in Persian, answering a Persian message: a 1.7B model that
// got confused about the reply language gives up out loud instead of answering. It
// is wrong - the model can write the language it just used to complain - and it is
// the sentence that then gets stored and repeated. Matched by shape rather than by
// exact wording, because it appears in every language the model knows.
const CANT = /(cannot|can ?not|can't|unable to|not able to|نمی\s?توانم|نمی توانم|قادر نیستم|لا أستطيع|لا استطيع|не могу|kann nicht|no puedo|ne peux pas|yapamam)/i;
const SPEAK = /(speak|speaking|answer|reply|respond|write|communicate|صحبت|پاسخ|جواب|نوشتن|أجيب|اجيب|الإجابة|الاجابة|إجابة|اجابة|أتحدث|اتحدث|говорить|отвечать|ответить|ответ|sprechen|antworten|hablar|responder|parler|répondre|konuş)/i;
const LANGUAGE_WORD = /(english|persian|farsi|arabic|german|french|spanish|russian|turkish|chinese|japanese|korean|dutch|italian|portuguese|hindi|urdu|انگلیسی|فارسی|عربی|آلمانی|فرانسوی|اسپانیایی|روسی|ترکی|چینی|ژاپنی|هندی|اردو|английск|русск|персидск|englisch|deutsch|französisch|français|anglais|español|inglés|türkçe|italiano|português|nederlands|الإنجليزية|الانجليزية|الانجلیزیه|الانجليزيه)/i;

export function isLanguageRefusal(answer) {
  // Tested twice: once on the text as written, and once after normalise(), because
  // the normaliser folds Arabic spellings into Persian ones (ي -> ی, ة -> ه) and
  // Persian arrives with a ZWNJ inside "نمی‌توانم". Neither form alone catches both.
  const raw = String(answer ?? '').toLowerCase();
  const folded = normalise(answer);
  if (!folded) return false;
  const has = (re) => re.test(raw) || re.test(folded);
  return has(CANT) && has(SPEAK) && has(LANGUAGE_WORD);
}

// The same sentence twice inside one answer.
function isStutter(answer) {
  const s = sentences(answer);
  if (s.length < 2) return false;
  const seen = new Set();
  for (const one of s) {
    if (seen.has(one)) return true;
    seen.add(one);
  }
  return false;
}

// -> { ok, reasons } - reasons are the human-readable names of what went wrong.
export function analyseAnswer({ answer, userText = '', recentAnswers = [] } = {}) {
  const text = String(answer ?? '').trim();
  const reasons = [];
  if (!text) return { ok: false, reasons: ['empty'] };
  if (isEcho(text, userText)) reasons.push('echo');
  if (isLoop(text, recentAnswers)) reasons.push('loop');
  if (isStutter(text)) reasons.push('stutter');
  if (isLanguageRefusal(text)) reasons.push('refusal');
  return { ok: reasons.length === 0, reasons };
}

import { isLanguageInput, resolveLanguage } from './lang.js';


// Said instead of a reply that repeated itself. Honest about what happened, short,
// and in the language of the conversation. Deliberately not stored in history: it
// is the app talking, not the conversation.
const FALLBACK = {
  en: 'That reply came out wrong on my side — I was repeating you instead of answering. Ask me again, in a few more words?',
  fa: 'پاسخم درست از آب درنیامد — داشتم حرف شما را تکرار می‌کردم. لطفاً دوباره و کمی کامل‌تر بپرسید.',
  ar: 'لم تكن إجابتي صحيحة — كنت أكرر كلامك بدل أن أجيب. اسألني مرة أخرى وبكلمات أكثر.',
  es: 'La respuesta me salió mal — estaba repitiéndote en vez de contestar. ¿Me lo preguntas otra vez, con alguna palabra más?',
  fr: 'Ma réponse est mal sortie — je répétais vos mots au lieu de répondre. Pouvez-vous redemander, avec un peu plus de mots ?',
  de: 'Meine Antwort ist schiefgegangen — ich habe dich wiederholt statt zu antworten. Frag mich bitte noch einmal, mit ein paar Worten mehr.',
  tr: 'Yanıtım yanlış çıktı — cevap vermek yerine sizi tekrar ediyordum. Birkaç kelime daha ekleyip yeniden sorar mısınız?',
  ru: 'Ответ получился неудачным — я повторял вас вместо того, чтобы ответить. Спросите ещё раз, чуть подробнее?',
  zh: '我的回复出错了 — 我在重复你的话，而没有回答。能不能再问一次，多写几个字？',
  hi: 'मेरा जवाब गड़बड़ हो गया — मैं जवाब देने के बजाय आपकी बात दोहरा रहा था। कृपया थोड़ा और लिखकर फिर पूछें?',
  sv: 'Mitt svar blev fel — jag upprepade dig i stället för att svara. Fråga igen, med några ord till?',
};

// The apology follows the reply language: a code, a name an older build stored
// ("Swedish"), or a language with no sentence of its own - which gets English,
// because an unchecked translation is worse than a sentence that is understood.
export function degenerateReply(lang = 'en') {
  const code = isLanguageInput(lang) ? resolveLanguage(lang).code : 'en';
  return FALLBACK[code] ?? FALLBACK.en;
}

// The nudge for the second attempt. It goes in as a system message, after the
// conversation, because that is what a small model attends to most.
// The nudge sent with the retry. `reasons` lets it name what actually went wrong:
// telling a model "do not copy the message" when it just claimed it cannot speak
// English is a nudge in the wrong direction, and costs a second slow call to learn
// nothing.
export function correctionNote(reasons = []) {
  const parts = ['The previous attempt is discarded.'];
  if (reasons.includes('refusal')) {
    parts.push('You can read and write the language the person used - you just wrote it - '
      + 'so never say you cannot answer in a language, and never mention the language at all. '
      + 'Answer the question itself.');
  }
  if (reasons.includes('echo') || reasons.includes('loop') || reasons.includes('stutter')) {
    parts.push('It repeated the message or your own earlier reply instead of answering.');
  }
  parts.push('Answer in your own words, do not copy the message, and if you have nothing to say, '
    + 'say briefly that you did not understand.');
  return parts.join(' ');
}
