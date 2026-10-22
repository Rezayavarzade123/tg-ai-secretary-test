// Language registry, language detection and the prompt line that enforces it.
// No dependencies, so it runs inside the serverless runtime and the local runner alike.

// `prompt` is the name the model is told to use. `native` is what the panel shows.
export const LANGUAGES = [
  { code: 'en', label: 'English',  native: 'English',    prompt: 'English',           dir: 'ltr' },
  { code: 'fa', label: 'Persian',  native: 'فارسی',       prompt: 'Persian (Farsi)',   dir: 'rtl' },
  { code: 'ar', label: 'Arabic',   native: 'العربية',     prompt: 'Arabic',            dir: 'rtl' },
  { code: 'tr', label: 'Turkish',  native: 'Türkçe',      prompt: 'Turkish',           dir: 'ltr' },
  { code: 'de', label: 'German',   native: 'Deutsch',     prompt: 'German',            dir: 'ltr' },
  { code: 'fr', label: 'French',   native: 'Français',    prompt: 'French',            dir: 'ltr' },
  { code: 'es', label: 'Spanish',  native: 'Español',     prompt: 'Spanish',           dir: 'ltr' },
  { code: 'it', label: 'Italian',  native: 'Italiano',    prompt: 'Italian',           dir: 'ltr' },
  { code: 'pt', label: 'Portuguese', native: 'Português', prompt: 'Portuguese',        dir: 'ltr' },
  { code: 'nl', label: 'Dutch',    native: 'Nederlands',  prompt: 'Dutch',             dir: 'ltr' },
  { code: 'ru', label: 'Russian',  native: 'Русский',     prompt: 'Russian',           dir: 'ltr' },
  { code: 'hi', label: 'Hindi',    native: 'हिन्दी',        prompt: 'Hindi',             dir: 'ltr' },
  { code: 'zh', label: 'Chinese',  native: '中文',         prompt: 'Chinese',           dir: 'ltr' },
  { code: 'ja', label: 'Japanese', native: '日本語',        prompt: 'Japanese',          dir: 'ltr' },
  { code: 'ko', label: 'Korean',   native: '한국어',        prompt: 'Korean',            dir: 'ltr' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export function isLanguage(code) {
  return BY_CODE.has(String(code || '').toLowerCase());
}

export function language(code) {
  return BY_CODE.get(String(code || '').toLowerCase()) ?? null;
}

// The name used inside prompts ("German", "Persian (Farsi)"). Unknown codes are
// passed through so the model still understands them.
export function languagePromptName(code) {
  return language(code)?.prompt ?? String(code || 'English');
}

// ---------------------------------------------------------------------------
// Detection. Deliberately cheap: script tests first, then stop-word scoring for
// languages that share the Latin alphabet. Good enough to notice that someone
// switched language mid-conversation, which is all the reply-language setting
// needs. Returns a language code, or null when nothing is recognisable.
// ---------------------------------------------------------------------------
const SCRIPTS = [
  { test: /[\u3040-\u30ff]/, code: 'ja' },              // kana (before Han: Japanese uses both)
  { test: /[\uac00-\ud7af\u1100-\u11ff]/, code: 'ko' },
  { test: /[\u4e00-\u9fff]/, code: 'zh' },
  { test: /[\u0400-\u04ff]/, code: 'ru' },
  { test: /[\u0590-\u05ff]/, code: 'he' },
  { test: /[\u0900-\u097f]/, code: 'hi' },
  { test: /[\u0370-\u03ff]/, code: 'el' },
];

// Latin languages, scored by the words that appear in almost every sentence of
// that language. Stems include the Persian-influenced and Turkish variants.
const LATIN_HINTS = {
  en: ['the', 'and', 'you', 'is', 'are', 'to', 'what', 'hello', 'thanks', 'please', 'with'],
  de: ['der', 'die', 'das', 'und', 'ich', 'nicht', 'ist', 'du', 'wir', 'bitte', 'danke', 'hallo', 'eine', 'habe'],
  fr: ['le', 'la', 'les', 'et', 'je', 'vous', 'est', 'pas', 'pour', 'bonjour', 'merci'],
  es: ['el', 'la', 'los', 'y', 'yo', 'usted', 'es', 'que', 'para', 'hola', 'gracias'],
  it: ['il', 'la', 'e', 'io', 'sono', 'non', 'per', 'ciao', 'grazie', 'che'],
  pt: ['o', 'a', 'e', 'eu', 'voce', 'não', 'nao', 'para', 'ola', 'obrigado', 'que'],
  nl: ['de', 'het', 'en', 'ik', 'niet', 'is', 'je', 'voor', 'hallo', 'dank'],
  tr: ['ve', 'bir', 'bu', 'için', 'icin', 'değil', 'degil', 'merhaba', 'teşekkür', 'tesekkur', 'ben'],
  id: ['dan', 'yang', 'saya', 'tidak', 'untuk', 'halo', 'terima', 'apa'],
};

function detectLatin(text) {
  const words = text.toLowerCase().match(/[a-zà-öø-ÿğışçöü]+/g) || [];
  if (words.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const [code, hints] of Object.entries(LATIN_HINTS)) {
    let score = 0;
    for (const w of words) if (hints.includes(w)) score++;
    if (score > bestScore) { bestScore = score; best = code; }
  }
  // One matching stop-word is noise; require at least two, or a single one in a
  // very short message where it is the only signal there is.
  if (bestScore >= 2) return best;
  if (bestScore === 1 && words.length <= 3) return best;
  return null;
}

// Persian and Arabic share a script. Persian-specific letters decide it; if only
// shared letters appear, the default is Persian (the common case in this repo).
const PERSIAN_ONLY = /[\u067e\u0686\u0698\u06af\u06cc\u06a9]/;   // پ چ ژ گ ی ک
const ARABIC_ONLY = /[\u0629\u0649\u0643\u06c1]/;                // ة ى ك ہ

function detectArabicScript(text) {
  if (PERSIAN_ONLY.test(text)) return 'fa';
  if (ARABIC_ONLY.test(text)) return 'ar';
  return 'fa';
}

export function detectLang(text) {
  const s = String(text ?? '');
  if (!s.trim()) return null;
  for (const s2 of SCRIPTS) if (s2.test.test(s)) return s2.code;
  if (/[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/.test(s)) return detectArabicScript(s);
  if (/[a-z]/i.test(s)) return detectLatin(s);
  return null;
}

// ---------------------------------------------------------------------------
// The line added to the system prompt.
// ---------------------------------------------------------------------------
export function languageLine({ lang = 'en', auto = true } = {}) {
  if (auto) {
    return `Language: reply in the language of the person's latest message (default: ${languagePromptName(lang)}). Keep the language consistent inside one reply.`;
  }
  return `Language: always reply in ${languagePromptName(lang)}, even if the person writes in another language. Do not switch unless they explicitly ask you to translate.`;
}

// For the bot's own (non-model) strings, English is the fallback.
export function resolveLang(preferred, text) {
  const detected = detectLang(text);
  if (detected && isLanguage(detected)) return detected;
  const p = String(preferred || 'en').toLowerCase();
  return isLanguage(p) ? p : 'en';
}
