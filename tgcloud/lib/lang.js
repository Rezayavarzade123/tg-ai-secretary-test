// Language registry, language detection and the prompt line that enforces it.
// No dependencies, so it runs inside the serverless runtime and the local runner alike.
//
// "Any language" is the rule here. The registry below is a list of languages the app
// can *name* and translate its own short safety sentences into; it is not a list of
// what the model may speak. A setting of `sv`, `tlh` or `Swedish` all work: the
// prompt says "reply in Swedish", detection keeps up with the person writing, and a
// language that is not in the registry simply gets less help from the app.

// `prompt` is the name the model is told to use. `native` is what the panel shows.
export const LANGUAGES = [
  { code: 'en', label: 'English',    native: 'English',      prompt: 'English',          dir: 'ltr' },
  { code: 'fa', label: 'Persian',    native: 'فارسی',         prompt: 'Persian (Farsi)',  dir: 'rtl' },
  { code: 'ar', label: 'Arabic',     native: 'العربية',       prompt: 'Arabic',           dir: 'rtl' },
  { code: 'ur', label: 'Urdu',       native: 'اردو',          prompt: 'Urdu',             dir: 'rtl' },
  { code: 'he', label: 'Hebrew',     native: 'עברית',         prompt: 'Hebrew',           dir: 'rtl' },
  { code: 'tr', label: 'Turkish',    native: 'Türkçe',        prompt: 'Turkish',          dir: 'ltr' },
  { code: 'de', label: 'German',     native: 'Deutsch',       prompt: 'German',           dir: 'ltr' },
  { code: 'fr', label: 'French',     native: 'Français',      prompt: 'French',           dir: 'ltr' },
  { code: 'es', label: 'Spanish',    native: 'Español',       prompt: 'Spanish',          dir: 'ltr' },
  { code: 'it', label: 'Italian',    native: 'Italiano',      prompt: 'Italian',          dir: 'ltr' },
  { code: 'pt', label: 'Portuguese', native: 'Português',     prompt: 'Portuguese',       dir: 'ltr' },
  { code: 'nl', label: 'Dutch',      native: 'Nederlands',    prompt: 'Dutch',            dir: 'ltr' },
  { code: 'sv', label: 'Swedish',    native: 'Svenska',       prompt: 'Swedish',          dir: 'ltr' },
  { code: 'no', label: 'Norwegian',  native: 'Norsk',         prompt: 'Norwegian',        dir: 'ltr' },
  { code: 'da', label: 'Danish',     native: 'Dansk',         prompt: 'Danish',           dir: 'ltr' },
  { code: 'fi', label: 'Finnish',    native: 'Suomi',         prompt: 'Finnish',          dir: 'ltr' },
  { code: 'pl', label: 'Polish',     native: 'Polski',        prompt: 'Polish',           dir: 'ltr' },
  { code: 'cs', label: 'Czech',      native: 'Čeština',       prompt: 'Czech',            dir: 'ltr' },
  { code: 'ro', label: 'Romanian',   native: 'Română',        prompt: 'Romanian',         dir: 'ltr' },
  { code: 'hu', label: 'Hungarian',  native: 'Magyar',        prompt: 'Hungarian',        dir: 'ltr' },
  { code: 'ru', label: 'Russian',    native: 'Русский',       prompt: 'Russian',          dir: 'ltr' },
  { code: 'uk', label: 'Ukrainian',  native: 'Українська',    prompt: 'Ukrainian',        dir: 'ltr' },
  { code: 'el', label: 'Greek',      native: 'Ελληνικά',      prompt: 'Greek',            dir: 'ltr' },
  { code: 'id', label: 'Indonesian', native: 'Bahasa Indonesia', prompt: 'Indonesian',    dir: 'ltr' },
  { code: 'vi', label: 'Vietnamese', native: 'Tiếng Việt',     prompt: 'Vietnamese',       dir: 'ltr' },
  { code: 'hi', label: 'Hindi',      native: 'हिन्दी',          prompt: 'Hindi',            dir: 'ltr' },
  { code: 'bn', label: 'Bengali',    native: 'বাংলা',          prompt: 'Bengali',          dir: 'ltr' },
  { code: 'th', label: 'Thai',       native: 'ไทย',           prompt: 'Thai',             dir: 'ltr' },
  { code: 'zh', label: 'Chinese',    native: '中文',            prompt: 'Chinese',          dir: 'ltr' },
  { code: 'ja', label: 'Japanese',   native: '日本語',           prompt: 'Japanese',         dir: 'ltr' },
  { code: 'ko', label: 'Korean',     native: '한국어',           prompt: 'Korean',           dir: 'ltr' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

// A name lookup, so "/lang Swedish", "/lang svenska" and "lang=Swedish" all work.
const BY_NAME = new Map();
for (const l of LANGUAGES) {
  BY_NAME.set(l.label.toLowerCase(), l.code);
  BY_NAME.set(l.native.toLowerCase(), l.code);
  BY_NAME.set(l.prompt.toLowerCase(), l.code);
  BY_CODE.set(l.code, l);
}
// Extras people actually type.
for (const [alias, code] of Object.entries({
  farsi: 'fa', persian: 'fa', arabic: 'ar', urdu: 'ur', hebrew: 'he',
  turkish: 'tr', german: 'de', french: 'fr', spanish: 'es', italian: 'it',
  portuguese: 'pt', dutch: 'nl', swedish: 'sv', norwegian: 'no', danish: 'da',
  finnish: 'fi', polish: 'pl', czech: 'cs', romanian: 'ro', hungarian: 'hu',
  russian: 'ru', ukrainian: 'uk', greek: 'el', indonesian: 'id', vietnamese: 'vi',
  hindi: 'hi', bengali: 'bn', thai: 'th', chinese: 'zh', mandarin: 'zh',
  japanese: 'ja', korean: 'ko', english: 'en',
  eng: 'en', fars: 'fa', dutch_nl: 'nl',
})) {
  BY_NAME.set(alias, code);
}
BY_NAME.set('norsk', 'no');
BY_NAME.set('dansk', 'da');
BY_NAME.set('svenska', 'sv');

export function isLanguage(code) {
  return BY_CODE.has(String(code || '').toLowerCase());
}

export function language(code) {
  return BY_CODE.get(String(code || '').toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------
// Any language: a setting may be a code from the list, a name, a regional tag
// (sv-SE) or something this build has never heard of.
// ---------------------------------------------------------------------------
const RTL_SCRIPT = /[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/;

export function isLanguageInput(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 40) return false;
  // Letters and digits, spaces, underscores and hyphens - enough for "pt-BR",
  // "Bahasa Indonesia" and "فارسی", and nothing that could be a path or a sentence.
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(raw)) return false;
  // At least one letter and at least two characters: a bare "42" or "a" is a typo,
  // not a language, and it used to be stored as one.
  if (!/\p{L}{2}/u.test(raw)) return false;
  return true;
}

// Always returns an entry: { code, label, native, prompt, dir, known }.
export function resolveLanguage(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ...language('en'), known: true };

  const lower = raw.toLowerCase();
  const base = lower.split(/[-_]/)[0];
  const known = BY_CODE.get(lower) ?? BY_CODE.get(base);
  if (known) return { ...known, known: true };

  const named = BY_NAME.get(lower) ?? BY_NAME.get(base);
  if (named) {
    const entry = BY_CODE.get(named);
    if (entry) return { ...entry, known: true };
  }

  // Something this build has no entry for. Pass it to the model as written - a name
  // it knows ("Klingon") is better than a code it may not - and keep the code short
  // and lower-case so settings stay stable.
  const isCode = /^[a-z]{2,3}$/i.test(base) && base === lower;
  return {
    code: base,
    label: isCode ? base.toUpperCase() : raw.charAt(0).toUpperCase() + raw.slice(1),
    native: isCode ? base : raw,
    prompt: raw,
    dir: RTL_SCRIPT.test(raw) ? 'rtl' : 'ltr',
    known: false,
  };
}

// The name used inside prompts ("German", "Persian (Farsi)"). Unknown codes are
// passed through so the model still understands them.
export function languagePromptName(code) {
  return resolveLanguage(code).prompt;
}

// ---------------------------------------------------------------------------
// Detection. Deliberately cheap: script tests first, then the diacritics that
// belong to one language, then stop-word scoring for the rest of the Latin
// alphabet. Good enough to notice that someone switched language mid-conversation,
// which is all the reply-language setting needs. Returns a language code, or null
// when nothing is recognisable.
// ---------------------------------------------------------------------------
const SCRIPTS = [
  { test: /[\u3040-\u30ff]/, code: 'ja' },                 // kana (before Han: Japanese uses both)
  { test: /[\uac00-\ud7af\u1100-\u11ff]/, code: 'ko' },
  { test: /[\u4e00-\u9fff]/, code: 'zh' },
  { test: /[\u0e00-\u0e7f]/, code: 'th' },
  { test: /[\u0980-\u09ff]/, code: 'bn' },
  { test: /[\u0900-\u097f]/, code: 'hi' },                 // Devanagari (Hindi, Marathi…)
  { test: /[\u0a00-\u0a7f]/, code: 'pa' },                 // Gurmukhi
  { test: /[\u0a80-\u0aff]/, code: 'gu' },                 // Gujarati
  { test: /[\u0b80-\u0bff]/, code: 'ta' },                 // Tamil
  { test: /[\u0c00-\u0c7f]/, code: 'te' },                 // Telugu
  { test: /[\u0c80-\u0cff]/, code: 'kn' },                 // Kannada
  { test: /[\u0d00-\u0d7f]/, code: 'ml' },                 // Malayalam
  { test: /[\u0d80-\u0dff]/, code: 'si' },                 // Sinhala
  { test: /[\u1000-\u109f]/, code: 'my' },                 // Burmese
  { test: /[\u1780-\u17ff]/, code: 'km' },                 // Khmer
  { test: /[\u10a0-\u10ff]/, code: 'ka' },                 // Georgian
  { test: /[\u0530-\u058f]/, code: 'hy' },                 // Armenian
  { test: /[\u1200-\u137f]/, code: 'am' },                 // Ethiopic
  { test: /[\u0590-\u05ff]/, code: 'he' },
  { test: /[\u0370-\u03ff]/, code: 'el' },
  { test: /[\u0400-\u04ff]/, code: 'ru' },                 // refined for Ukrainian below
];

// Letters that exist in exactly one language. Stronger than any stop-word, which is
// why they are checked first: a single "å" or "ł" is worth ten "the"s.
const LATIN_LETTERS = [
  { test: /[ěščřžůťďň]/i, code: 'cs' },
  { test: /[ąćęłńśźż]/i, code: 'pl' },
  { test: /[șțăî]/i, code: 'ro' },
  { test: /[őű]/i, code: 'hu' },
  { test: /[ğış]/i, code: 'tr' },                          // dotless i, soft g
  { test: /[ơưđạảấầẩẫậắằẳẵặẹẻẽếềểễệịỉọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i, code: 'vi' },
  { test: /[ãõ]/i, code: 'pt' },
  { test: /[¿¡ñ]/i, code: 'es' },
  { test: /[æø]/i, code: 'no' },                           // Danish and Norwegian share these
  { test: /[åäö]/i, code: 'sv' },
  { test: /[ß]/i, code: 'de' },
];

// Latin languages, scored by the words that appear in almost every sentence of
// that language. Every hint is at least two letters: one-letter words ("a", "i",
// "w") belong to half the languages at once and only create false positives.
const LATIN_HINTS = {
  en: ['the', 'and', 'you', 'is', 'are', 'to', 'what', 'hello', 'thanks', 'please', 'with', 'have'],
  de: ['der', 'die', 'das', 'und', 'ich', 'nicht', 'ist', 'du', 'wir', 'bitte', 'danke', 'hallo', 'eine', 'habe', 'sie'],
  fr: ['le', 'la', 'les', 'et', 'je', 'vous', 'est', 'pas', 'pour', 'bonjour', 'merci', 'avec', 'nous'],
  es: ['el', 'los', 'yo', 'usted', 'es', 'que', 'para', 'hola', 'gracias', 'con', 'por', 'está'],
  it: ['il', 'io', 'sono', 'non', 'per', 'ciao', 'grazie', 'che', 'con', 'una'],
  pt: ['eu', 'voce', 'não', 'nao', 'para', 'ola', 'obrigado', 'que', 'com', 'uma', 'você'],
  nl: ['het', 'en', 'ik', 'niet', 'is', 'je', 'voor', 'hallo', 'dank', 'een', 'met', 'wat'],
  tr: ['ve', 'bir', 'bu', 'için', 'icin', 'değil', 'degil', 'merhaba', 'teşekkür', 'tesekkur', 'ben', 'nasılsın'],
  sv: ['och', 'att', 'jag', 'inte', 'är', 'det', 'som', 'för', 'med', 'hej', 'tack', 'hur'],
  da: ['og', 'jeg', 'ikke', 'er', 'det', 'som', 'til', 'med', 'hej', 'tak', 'hvordan'],
  no: ['og', 'jeg', 'ikke', 'er', 'det', 'som', 'til', 'med', 'hei', 'takk', 'hvordan'],
  fi: ['ja', 'on', 'ei', 'että', 'minä', 'sinä', 'kiitos', 'moi', 'mitä', 'kuinka'],
  pl: ['nie', 'jest', 'że', 'się', 'dla', 'cześć', 'dziękuję', 'jak', 'tak', 'jestem'],
  cs: ['je', 'se', 'na', 'že', 'pro', 'ahoj', 'děkuji', 'jak', 'není', 'jsem'],
  ro: ['și', 'sau', 'nu', 'este', 'care', 'pentru', 'mulțumesc', 'salut', 'sunt', 'cum'],
  hu: ['és', 'az', 'nem', 'van', 'hogy', 'köszönöm', 'szia', 'vagy', 'még'],
  id: ['dan', 'yang', 'saya', 'tidak', 'untuk', 'halo', 'terima', 'apa', 'dengan', 'ini'],
  vi: ['và', 'là', 'không', 'có', 'của', 'tôi', 'bạn', 'cảm', 'ơn', 'chào', 'này'],
};

function detectLatin(text) {
  const strong = LATIN_LETTERS.find((r) => r.test.test(text));
  if (strong) return strong.code;

  const words = text.toLowerCase().match(/[\p{L}]+/gu) || [];
  if (words.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const [code, hints] of Object.entries(LATIN_HINTS)) {
    const usable = hints.filter((w) => w.length >= 2);
    let score = 0;
    for (const w of words) if (usable.includes(w)) score++;
    if (score > bestScore) { bestScore = score; best = code; }
  }
  // One matching stop-word is noise; require at least two, or a single one in a
  // very short message where it is the only signal there is.
  if (bestScore >= 2) return best;
  if (bestScore === 1 && words.length <= 3) return best;
  return null;
}

// Persian, Urdu and Arabic share a script. Each has letters the others do not use.
const URDU_ONLY = /[\u0679\u0688\u0691\u06ba\u06be\u06d2\u06d3\u06af\u06a9]/;   // ٹ ڈ ڑ ں ھ ے ۓ
const PERSIAN_ONLY = /[\u067e\u0686\u0698\u06af\u06cc\u06a9]/;                  // پ چ ژ گ ی ک
const ARABIC_ONLY = /[\u0629\u0649\u0643\u06c1]/;                               // ة ى ك ہ

function detectArabicScript(text) {
  if (URDU_ONLY.test(text)) return 'ur';
  if (PERSIAN_ONLY.test(text)) return 'fa';
  if (ARABIC_ONLY.test(text)) return 'ar';
  return 'fa';
}

// Ukrainian, Bulgarian and Russian share Cyrillic; these four letters are Ukrainian.
const UKRAINIAN_ONLY = /[\u0456\u0457\u0454\u0491]/;   // і ї є ґ

export function detectLang(text) {
  const s = String(text ?? '');
  if (!s.trim()) return null;
  for (const s2 of SCRIPTS) {
    if (!s2.test.test(s)) continue;
    if (s2.code === 'ru' && UKRAINIAN_ONLY.test(s)) return 'uk';
    return s2.code;
  }
  if (/[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/.test(s)) return detectArabicScript(s);
  if (/[a-z]/i.test(s)) return detectLatin(s);
  return null;
}

// ---------------------------------------------------------------------------
// The line added to the system prompt.
// ---------------------------------------------------------------------------
export function languageLine({ lang = 'en', auto = true } = {}) {
  const name = languagePromptName(lang);
  if (auto) {
    return `Language: reply in the language of the person's latest message (default: ${name}). Keep the language consistent inside one reply.`;
  }
  return `Language: always reply in ${name}, even if the person writes in another language. Do not switch unless they explicitly ask you to translate.`;
}

// Which language to answer in.
//
// detectLang() needs two stop-word hits before it names a Latin language, so plain
// English often comes back null - and falling straight through to the owner's
// default is how a Persian-default bot ended up answering English speakers with
// "I am an automated assistant and cannot talk in English". Latin letters and no
// better evidence is English; that is the honest reading of "undetected".
// Languages written with Latin letters. Used only to decide what to do when a
// message is Latin but nothing in it identifies the language: if the setting is one
// of these, or a language the app has never heard of, the setting is the better
// guess - a Swedish owner writing "jag kan inte komma" should not get English.
export const LATIN_LANGS = new Set(['en', 'tr', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'sv', 'no', 'da', 'fi',
  'pl', 'cs', 'ro', 'hu', 'id', 'vi', 'tl', 'sw', 'hr', 'sk', 'sl', 'et', 'lv', 'lt', 'ms', 'ca', 'gl', 'eu', 'af']);

// True when the language is written with Latin letters. A language this build has
// never heard of returns false here and is handled by the caller, which knows
// whether "unknown" should mean "be careful" or "cannot judge".
export function isLatinScriptLang(code) {
  return LATIN_LANGS.has(String(code || '').trim().toLowerCase().split(/[-_]/)[0]);
}

export function resolveLang(preferred, text) {
  const detected = detectLang(text);
  if (detected && isLanguage(detected)) return detected;
  // Two or more Latin words and no better evidence. One word ("ok") proves nothing,
  // so the setting still wins there.
  const latinWords = (String(text ?? '').match(/[\p{L}]+/gu) || []).filter((w) => /[a-z]/i.test(w)).length;
  if (latinWords >= 2 && !RTL_SCRIPT.test(String(text ?? ''))) {
    // A Latin-script setting (or one this build does not know) keeps the setting;
    // a non-Latin setting cannot answer a Latin message, so English is the honest
    // guess - that was the v1.7.4 fix for "Persian default, English sender".
    // A setting written by an older build may be a name ("Swedish") rather than a
    // code, so resolve it the same way the setting field does.
    const p = isLanguageInput(preferred) ? resolveLanguage(preferred).code : '';
    if (p && LATIN_LANGS.has(p)) return p;
    if (p && !isLanguage(p)) return p;
    return 'en';
  }
  // A known language from the setting - a code, or a name an older build stored.
  // Anything else is a typo as far as the app's own sentences go, and English is
  // the safe fallback. (The setting itself still reaches the model as written:
  // see resolveLanguage and languagePromptName.)
  const p = isLanguageInput(preferred) ? resolveLanguage(preferred).code : '';
  return isLanguage(p) ? p : 'en';
}
