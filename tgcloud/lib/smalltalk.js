// Answers that should never be left to a 1–2B model.
//
// "سلام" answered with "سلام! ما روی از چی؟" is not a model-quality problem to fix
// with a better prompt; it is a greeting. The same goes for "who are you", "do you
// know me" and "thanks". Answering those from code is instant on a slow CPU, exact
// in the right language, and cannot repeat itself.
//
// Recognition is multi-lingual; the written replies cover the languages this file
// can speak well (en, fa, ar, es, fr, de, tr, ru). For any other language the
// matcher returns null on purpose: the model answers, in a language it knows, and
// the repetition checks in lib/degenerate.js still stand behind it. Writing a
// greeting in a language nobody here can check would be worse than silence.

import { normalise } from './degenerate.js';
import { resolveLanguage } from './lang.js';

const MAX_WORDS = 6;

// \b is useless here: JavaScript's \w is ASCII, so a word boundary after "سلام"
// never matches and the pattern silently never fires. Anchor on whitespace or the
// end instead - an explicit end-of-word that works in every script.
const END = '(?=$|[\\s,.!?؟،:;…])';

// Greetings, in as many spellings as people actually use.
const GREETING = '(?:سلام علیکم|سلام|درود|وقت بخیر|صبح بخیر|عصر بخیر|شب بخیر'
  + '|صبحك بالخير|مرحبا|أهلا|السلام عليكم'
  + '|hi|hello|hey|yo|good morning|good evening|greetings'
  + '|hallo|guten tag|guten morgen|servus'
  + '|bonjour|salut|bonsoir'
  + '|hola|buenos días|buenas tardes|qué tal'
  + '|ciao|buongiorno|buonasera'
  + '|olá|oi|bom dia|boa tarde'
  + '|hallo|hoi|goedemorgen'
  + '|merhaba|selam|günaydın'
  + '|привет|здравствуйте|добрый день|добрый вечер'
  + '|hej|hallå|goddag'
  + '|cześć|witaj|dzień dobry'
  + '|שלום'
  + '|नमस्ते|नमस्कार'
  + '|สวัสดี'
  + '|xin chào|chào'
  + '|halo)';

const INTENTS = [
  {
    id: 'greeting',
    // A whole-message greeting, with no question hiding inside it: "سلام، میشه فردا
    // جلسه بذاری؟" is a request that happens to start with a greeting.
    test: (t) => {
      const m = new RegExp(`^${GREETING}${END}`, 'iu').exec(t);
      return Boolean(m) && (bare(t.slice(m[0].length)) || FILLER.test(t.slice(m[0].length)));
    },
  },
  {
    id: 'howAreYou',
    test: (t) => any(t, [
      'خوبی', 'چطوری', 'حالت چطوره', 'كيف حالك', 'كيفك',
      'how are you', "how's it going", 'how are things',
      'wie geht', 'ça va', 'cómo estás', 'come stai', 'nasılsın', 'как дела',
      'hur är', 'jak się masz', 'מה שלומך', 'कैसे हो', 'สบายดี',
    ]) && t.split(' ').length <= MAX_WORDS,
  },
  {
    id: 'identity',
    test: (t) => any(t, [
      'تو کی هستی', 'کی هستی', 'چی هستی', 'شما کی هستید', 'ربات هستی', 'بات هستی', 'هوش مصنوعی هستی',
      'من أنت', 'من تكون', 'هل أنت روبوت',
      'who are you', 'what are you', 'are you a bot', 'are you human', 'what is your name',
      'wer bist du', 'qui es-tu', 'qui êtes-vous', 'quién eres', 'chi sei', 'sen kimsin',
      'кто ты', 'vem är du', 'kim jesteś', 'מי אתה',
    ]),
  },
  {
    id: 'knowMe',
    test: (t) => any(t, [
      'منو میشناسی', 'مرا میشناسی', 'می‌شناسی منو', 'منو می‌شناسي', 'هل تعرفني', 'تعرفني',
      'do you know me', 'do you know who i am', 'who am i',
      'kennst du mich', 'tu me connais', 'me conoces', 'mi conosci', 'beni tanıyor musun',
      'ты меня знаешь', 'känner du mig', 'znasz mnie',
    ]),
  },
  {
    id: 'thanks',
    test: (t) => {
      const m = new RegExp('^(?:' + [
      'ممنون', 'مرسی', 'تشکر', 'دستت درد نکنه', 'شكرا', 'شكراً',
      'thanks', 'thank you', 'thx', 'cheers',
      'danke', 'merci', 'gracias', 'grazie', 'obrigado', 'obrigada', 'teşekkürler',
      'спасибо', 'tack', 'dziękuję', 'תודה', 'धन्यवाद', 'ขอบคุณ', 'cảm ơn',
      ].join('|') + ')' + END, 'iu').exec(t);
      // "thanks, but send me the file" is a request, not a thank-you.
      return Boolean(m) && bare(t.slice(m[0].length));
    },
  },
];

// "hi there", "hi again", "hello dear": a greeting plus a word that adds nothing.
const FILLER = /^(?:[\s,.!?…-]*(?:there|again|all|everyone|everybody|friends|guys|folks|you|dear|my friend|بچه‌ها|بچه ها|دوستان|عزیز|حبیبی|جميعا))*[\s,.!?…-]*$/iu;

// Nothing left but punctuation: the message was the greeting and nothing else.
function bare(rest) {
  return rest.replace(/[\s,.!?؟،:;…~()\[\]"'«»-]+/gu, '') === '';
}

// Any of these phrases appears in the message. Plain substring matching on the
// normalised text: no word-boundary games, which do not work in every script.
function any(t, phrases) {
  return phrases.some((p) => t.includes(p));
}

const REPLIES = {
  en: {
    greeting: (o) => `Hello! It's ${o}'s assistant — what do you need?`,
    howAreYou: () => `I'm here and working. What can I do for you?`,
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
  es: {
    greeting: (o) => `¡Hola! Soy el asistente de ${o} — ¿qué necesitas?`,
    howAreYou: () => 'Aquí estoy, funcionando. ¿Qué puedo hacer por ti?',
    identity: (o) => `Soy el asistente de ${o}: un bot que corre en su propia máquina con un modelo local pequeño. Respondo aquí y, en modo secretario, preparo borradores en su cuenta.`,
    knowMe: (o) => `Eres ${o} — tú me configuraste y este es tu chat privado. Recuerdo lo que me digas con /remember y las notas de tu panel.`,
    thanks: () => 'De nada.',
  },
  fr: {
    greeting: (o) => `Bonjour ! Je suis l'assistant de ${o} — que puis-je faire ?`,
    howAreYou: () => `Je suis là, et je fonctionne. Que puis-je faire pour vous ?`,
    identity: (o) => `Je suis l'assistant de ${o} : un robot qui tourne sur sa propre machine avec un petit modèle local. Je réponds ici et, en mode secrétaire, je prépare des brouillons sur son compte.`,
    knowMe: (o) => `Vous êtes ${o} — c'est vous qui m'avez installé, et ceci est votre conversation privée. Je retiens ce que vous me dites avec /remember et les notes de votre panneau.`,
    thanks: () => 'Avec plaisir.',
  },
  de: {
    greeting: (o) => `Hallo! Ich bin der Assistent von ${o} — was brauchst du?`,
    howAreYou: () => 'Ich bin da und laufe. Was kann ich für dich tun?',
    identity: (o) => `Ich bin der Assistent von ${o}: ein Bot auf dem eigenen Rechner, mit einem kleinen lokalen Modell. Ich antworte hier und entwerfe im Sekretärsmodus Antworten auf dem Konto.`,
    knowMe: (o) => `Du bist ${o} — du hast mich eingerichtet, und das ist dein privater Chat. Ich merke mir, was du mit /remember sagst, und die Notizen im Panel.`,
    thanks: () => 'Gern.',
  },
  tr: {
    greeting: (o) => `Merhaba! Ben ${o} kişisinin asistanıyım — neye ihtiyacınız var?`,
    howAreYou: () => 'Buradayım ve çalışıyorum. Sizin için ne yapabilirim?',
    identity: (o) => `Ben ${o} kişisinin asistanıyım: kendi bilgisayarında küçük bir yerel modelle çalışan bir botum. Burada yanıt veririm, sekreter modunda hesabında taslak hazırlayabilirim.`,
    knowMe: (o) => `Siz ${o} kişisisiniz — beni siz kurdunuz ve burası sizin özel sohbetiniz. /remember ile söylediklerinizi ve panel notlarınızı hatırlarım.`,
    thanks: () => 'Rica ederim.',
  },
  ru: {
    greeting: (o) => `Здравствуйте! Я помощник ${o} — что нужно сделать?`,
    howAreYou: () => 'Я здесь и работаю. Чем могу помочь?',
    identity: (o) => `Я помощник ${o}: бот, который работает на его собственном компьютере с небольшой локальной моделью. Отвечаю здесь, а в режиме секретаря готовлю черновики ответов на его аккаунте.`,
    knowMe: (o) => `Вы ${o} — вы меня установили, и это ваш личный чат. Я запоминаю то, что вы говорите через /remember, и заметки из панели.`,
    thanks: () => 'Пожалуйста.',
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

  // Only answer from code in a language this file can actually write.
  const code = resolveLanguage(lang).code;
  const table = REPLIES[code];
  if (!table) return null;

  return { id: intent.id, reply: table[intent.id](ownerName) };
}

export const SMALLTALK_LANGUAGES = Object.keys(REPLIES);
