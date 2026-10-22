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
  return { ok: reasons.length === 0, reasons };
}

// Said instead of a reply that repeated itself. Honest about what happened, short,
// and in the language of the conversation. Deliberately not stored in history: it
// is the app talking, not the conversation.
const FALLBACK = {
  en: 'That reply came out wrong on my side — I was repeating you instead of answering. Ask me again, in a few more words?',
  fa: 'پاسخم درست از آب درنیامد — داشتم حرف شما را تکرار می‌کردم. لطفاً دوباره و کمی کامل‌تر بپرسید.',
  ar: 'لم تكن إجابتي صحيحة — كنت أكرر كلامك بدل أن أجيب. اسألني مرة أخرى وبكلمات أكثر.',
};

export function degenerateReply(lang = 'en') {
  return FALLBACK[String(lang || 'en').toLowerCase()] ?? FALLBACK.en;
}

// The nudge for the second attempt. It goes in as a system message, after the
// conversation, because that is what a small model attends to most.
export function correctionNote() {
  return 'The previous attempt is discarded: it repeated the user instead of answering. '
    + 'Answer in your own words, do not copy the message, and if you have nothing to say, say briefly that you did not understand.';
}
