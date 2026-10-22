// Answers that should never be left to a 1–2B model.
//
// "سلام" answered with "سلام! ما روی از چی؟" is not a model-quality problem to fix
// with a better prompt; it is a greeting. The same goes for "who are you", "do you
// know me" and "thanks". Answering those from code is instant on a slow CPU, exact
// in the right language, and cannot repeat itself.
//
// The matcher is deliberately narrow: a short message (or an unmistakable phrase),
// never a request hiding behind a greeting. "سلام، میشه فردا جلسه بذاری؟" must reach
// the model, because it is a question, not a hello.

import { normalise } from './degenerate.js';

const MAX_WORDS = 6;

// \b is useless here: JavaScript's \w is ASCII, so a word boundary after "سلام"
// never matches and the pattern silently never fires. Anchor on whitespace or the
// end instead - an explicit end-of-word that works in every script.
const END = '(?=$|[\\s,.!?؟،:;…])';

const INTENTS = [
  {
    id: 'greeting',
    // Whole-message greeting, optionally with a "how are you" on the end.
    test: (t) => new RegExp(`^(سلام علیکم|سلام|درود|وقت بخیر|صبح بخیر|عصر بخیر|شب بخیر|hi|hello|hey|yo|good morning|good evening|salam)${END}`, 'u').test(t)
      && t.split(' ').length <= MAX_WORDS
      && !/[/\\]/.test(t),
  },
  {
    id: 'howAreYou',
    test: (t) => /(خوبی|چطوری|حالت چطوره|how are you|how's it going|how are things)/.test(t)
      && t.split(' ').length <= MAX_WORDS,
  },
  {
    id: 'identity',
    test: (t) => /(تو کی هستی|کی هستی|چی هستی|شما کی هستید|ربات هستی|بات هستی|هوش مصنوعی هستی|who are you|what are you|are you a bot|are you human|what is your name)/.test(t),
  },
  {
    id: 'knowMe',
    test: (t) => /(منو میشناسی|مرا میشناسی|می.?شناسی منو|منو مي.?شناسي|do you know me|do you know who i am|who am i)/.test(t),
  },
  {
    id: 'thanks',
    test: (t) => new RegExp(`^(ممنون|مرسی|تشکر|دستت درد نکنه|thanks|thank you|thx|cheers)${END}`, 'u').test(t)
      && t.split(' ').length <= MAX_WORDS,
  },
];

const REPLIES = {
  en: {
    greeting: (o) => `Hello! It's ${o}'s assistant — what do you need?`,
    howAreYou: (o) => `I'm here and working. What can I do for you?`,
    identity: (o) => `I'm ${o}'s assistant: a bot running on their own machine with a small local model. I answer here, and in Secretary mode I can draft replies on their account.`,
    knowMe: (o) => `You're ${o} — you set me up, and this is your private chat. I remember what you tell me here with /remember, and the notes in your control panel.`,
    thanks: () => 'Any time.',
  },
  fa: {
    greeting: (o) => `سلام! من دستیار ${o} هستم — چه کاری دارید؟`,
    howAreYou: () => 'من هستم و کار می‌کنم. چه کاری برایتان انجام بدهم؟',
    identity: (o) => `من دستیار ${o} هستم: یک ربات که روی کامپیوتر خودشان با یک مدل کوچک محلی اجرا می‌شود. اینجا جواب می‌دهم و در حالت منشی می‌توانم پیش‌نویس پاسخ روی حساب ایشان آماده کنم.`,
    knowMe: (o) => `شما ${o} هستید — خودتان مرا راه‌اندازی کردید و این چت خصوصی شماست. هرچه با /remember بگویید و یادداشت‌های پنل را به یاد می‌آورم.`,
    thanks: () => 'خواهش می‌کنم.',
  },
  ar: {
    greeting: (o) => `مرحباً! أنا مساعد ${o} — ماذا تحتاج؟`,
    howAreYou: () => 'أنا هنا وأعمل. كيف أساعدك؟',
    identity: (o) => `أنا مساعد ${o}: روبوت يعمل على جهازه الخاص بنموذج محلي صغير. أجيب هنا، وأستطيع في وضع السكرتير تجهيز ردود على حسابه.`,
    knowMe: (o) => `أنت ${o} — أنت من أعدّني، وهذه محادثتك الخاصة. أتذكر ما تقوله لي عبر ‎/remember وملاحظات لوحة التحكم.`,
    thanks: () => 'على الرحب والسعة.',
  },
};

// -> { id, reply } or null. `lang` is the resolved reply language.
export function matchSmalltalk(text, { ownerName = 'your assistant', lang = 'en' } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.startsWith('/')) return null;

  const t = normalise(raw);
  if (!t || t.length > 120) return null;

  const intent = INTENTS.find((i) => i.test(t));
  if (!intent) return null;

  const table = REPLIES[String(lang || 'en').toLowerCase()] ?? REPLIES.en;
  const make = table[intent.id] ?? REPLIES.en[intent.id];
  return { id: intent.id, reply: make(ownerName) };
}
