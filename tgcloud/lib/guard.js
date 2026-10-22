// Deterministic safety net around the model's outgoing text.
//
// A 1-2B model follows the "never claim to be the owner, never promise anything"
// rules most of the time. "Most of the time" is not good enough when the reply is
// sent from your personal Telegram account, so the same rules are checked here,
// in code, on the finished text.
//
// The checks are intentionally blunt: they replace a risky sentence with a fixed,
// safe sentence rather than trying to be clever about what the model meant.

// "I am the owner" / "I'm the boss" — a claim of authority that is not a name.
// Kept narrow on purpose: "I'm an automated assistant" must NOT be caught.
// No /g flag: the guard tests this regex on every outgoing message, and a global
// regex remembers lastIndex between calls, so .test() would answer true, false,
// true, false... and let every second impersonation through.
const OWNER_CLAIM = /\b(i am|i'm|this is|it'?s|speaking as)\s+(the\s+)?(owner|boss|manager|admin|administrator|person in charge|authori[sz]ed|real [a-z]+)\b/i;

// Commitments, prices, appointments, promises: things only the owner may decide.
const COMMITMENT = [
  /\bi(?:'ll| will)\s+(call|text|message|meet|send|pay|transfer|come|be there|book|arrange|fix|do it)\b/i,
  /\bi(?:'m| am)\s+(on my way|coming|free|available|at home)\b/i,
  /\b(let'?s|we can|you can)\s+(meet|talk|call|come|visit)\b/i,
  /\b(meet|see)\s+you\s+(at|on|tomorrow|tonight)\b/i,
  /\b(booked|reserved|confirmed|scheduled|paid|transferred|sent you)\b/i,
  /\b(it'?s|that'?s)\s+(fine|okay|ok|no problem|done|agreed)\b/i,
  /\b(tomorrow|tonight|today)\s+at\s+\d/i,
  /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i,
  /\b(price|cost|fee|rate)\s*(is|will be|:)?\s*\d/i,
  // Persian / Arabic commitment words
  /(تماس می.?گیرم|زنگ می.?زنم|می.?آیم|میام|می.?بینمت|حتما|قبول|می.?پردازم|واریز)/,
];

// Immediate danger: never hand this to a small model, answer with a fixed text.
const URGENT = [
  /\b(emergency|ambulance|hospital|accident|injured|bleeding|unconscious|heart attack|stroke|suicide|police|fire|missing|kidnapped)\b/i,
  /(اورژانس|آمبولانس|بیمارستان|تصادف|خونریزی|دکتر فوری|پلیس|آتش.?نشانی|دزدیده|گم شده)/,
  /(not breathing|can'?t breathe|overdose)/i,
];

const TEXTS = {
  en: {
    disclose: (owner) => `I'm ${owner}'s automated assistant. I've passed your message on, and ${owner} will reply personally.`,
    hold: (owner) => `I can't confirm or promise anything myself — I've passed this to ${owner} and they'll get back to you.`,
    urgent: (owner) => `This sounds urgent. Please call emergency services or ${owner} directly right now — I can't act on it fast enough.`,
    firstContact: (owner) => `Hi, this is ${owner}'s automated assistant. ${owner} isn't available right now — tell me what you need and I'll pass it on.`,
  },
  fa: {
    disclose: (owner) => `من دستیار خودکار ${owner} هستم. پیام شما را به ایشان می‌رسانم و خودشان پاسخ می‌دهند.`,
    hold: (owner) => `من نمی‌توانم چیزی را تأیید یا قول بدهم — پیام را به ${owner} می‌رسانم و ایشان پاسخ می‌دهند.`,
    urgent: (owner) => `این پیام فوری به نظر می‌رسد. لطفاً همین حالا با اورژانس یا مستقیماً با ${owner} تماس بگیرید — من به‌اندازه کافی سریع نمی‌توانم اقدام کنم.`,
    firstContact: (owner) => `سلام، من دستیار خودکار ${owner} هستم. ایشان الان در دسترس نیستند — بفرمایید چه کاری دارید تا منتقل کنم.`,
  },
  ar: {
    disclose: (owner) => `أنا المساعد الآلي لـ ${owner}. سأمرر رسالتك وسيجيبك شخصياً.`,
    hold: (owner) => `لا أستطيع تأكيد أو الوعد بشيء — سأمرر هذا إلى ${owner} وسيعود إليك.`,
    urgent: (owner) => `يبدو الأمر عاجلاً. اتصل بالطوارئ أو بـ ${owner} مباشرة الآن — لا أستطيع التصرف بالسرعة الكافية.`,
    firstContact: (owner) => `مرحباً، أنا المساعد الآلي لـ ${owner}. غير متوفر الآن — اكتب ما تحتاجه وسأمرره.`,
  },
  es: {
    disclose: (owner) => `Soy el asistente automático de ${owner}. Le paso tu mensaje y te responderá personalmente.`,
    hold: (owner) => `No puedo confirmar ni prometer nada — se lo paso a ${owner} y te responderá.`,
    urgent: (owner) => `Esto parece urgente. Llama ahora a los servicios de emergencia o directamente a ${owner} — no puedo actuar con la suficiente rapidez.`,
    firstContact: (owner) => `Hola, soy el asistente automático de ${owner}. No está disponible ahora: dime qué necesitas y se lo paso.`,
  },
  fr: {
    disclose: (owner) => `Je suis l'assistant automatique de ${owner}. Je transmets votre message et il vous répondra personnellement.`,
    hold: (owner) => `Je ne peux rien confirmer ni promettre — je transmets à ${owner} qui vous répondra.`,
    urgent: (owner) => `Cela semble urgent. Appelez immédiatement les secours ou directement ${owner} — je ne peux pas agir assez vite.`,
    firstContact: (owner) => `Bonjour, je suis l'assistant automatique de ${owner}. Il n'est pas disponible : dites-moi ce qu'il vous faut et je transmets.`,
  },
  de: {
    disclose: (owner) => `Ich bin der automatische Assistent von ${owner}. Ich gebe die Nachricht weiter, ${owner} antwortet persönlich.`,
    hold: (owner) => `Ich kann nichts zusagen oder versprechen — ich gebe es an ${owner} weiter.`,
    urgent: (owner) => `Das klingt dringend. Rufen Sie bitte sofort den Notruf oder ${owner} direkt an — ich kann nicht schnell genug handeln.`,
    firstContact: (owner) => `Hallo, ich bin der automatische Assistent von ${owner}. ${owner} ist gerade nicht erreichbar — sagen Sie mir, worum es geht, und ich gebe es weiter.`,
  },
  tr: {
    disclose: (owner) => `Ben ${owner} adına çalışan otomatik asistanım. Mesajınızı iletiyorum, kendisi size dönecek.`,
    hold: (owner) => `Hiçbir şeyi onaylayamam veya söz veremem — mesajı ${owner} kişisine iletiyorum.`,
    urgent: (owner) => `Bu acil görünüyor. Lütfen hemen acil servisi veya doğrudan ${owner} kişisini arayın — ben yeterince hızlı hareket edemem.`,
    firstContact: (owner) => `Merhaba, ben ${owner} adına çalışan otomatik asistanım. Şu anda müsait değil — neye ihtiyacınız olduğunu yazın, ileteyim.`,
  },
  ru: {
    disclose: (owner) => `Я автоматический помощник ${owner}. Я передам ваше сообщение, и ${owner} ответит лично.`,
    hold: (owner) => `Я не могу ничего подтвердить или обещать — я передам это ${owner}.`,
    urgent: (owner) => `Похоже, это срочно. Пожалуйста, сразу позвоните в экстренные службы или напрямую ${owner} — я не могу действовать достаточно быстро.`,
    firstContact: (owner) => `Здравствуйте, я автоматический помощник ${owner}. Сейчас он недоступен — напишите, что нужно, и я передам.`,
  },
  zh: {
    disclose: (owner) => `我是 ${owner} 的自动助理。我会转达您的消息，${owner} 会亲自回复。`,
    hold: (owner) => `我无法确认或承诺任何事情 — 我会把消息转给 ${owner}。`,
    urgent: (owner) => `这听起来很紧急。请立即拨打急救电话或直接联系 ${owner} — 我无法足够快地处理。`,
    firstContact: (owner) => `您好，我是 ${owner} 的自动助理。${owner} 现在无法回复 — 请告诉我您需要什么，我会转达。`,
  },
  hi: {
    disclose: (owner) => `मैं ${owner} का स्वचालित सहायक हूँ। मैं आपका संदेश पहुँचा दूँगा और ${owner} स्वयं जवाब देंगे।`,
    hold: (owner) => `मैं कुछ भी पुष्टि या वादा नहीं कर सकता — मैं यह ${owner} तक पहुँचा देता हूँ।`,
    urgent: (owner) => `यह ज़रूरी लगता है। कृपया तुरंत आपातकालीन सेवा या सीधे ${owner} को कॉल करें — मैं इतनी तेज़ी से कार्य नहीं कर सकता।`,
    firstContact: (owner) => `नमस्ते, मैं ${owner} का स्वचालित सहायक हूँ। ${owner} अभी उपलब्ध नहीं हैं — बताइए क्या चाहिए, मैं पहुँचा दूँगा।`,
  },
  sv: {
    disclose: (owner) => `Jag är ${owner}s automatiska assistent. Jag vidarebefordrar ditt meddelande och ${owner} svarar personligen.`,
    hold: (owner) => `Jag kan inte bekräfta eller lova något — jag skickar det vidare till ${owner}.`,
    urgent: (owner) => `Det här låter akut. Ring räddningstjänsten eller ${owner} direkt nu — jag kan inte agera tillräckligt snabbt.`,
    firstContact: (owner) => `Hej, jag är ${owner}s automatiska assistent. ${owner} är inte tillgänglig just nu — berätta vad du behöver så vidarebefordrar jag det.`,
  },
  pl: {
    disclose: (owner) => `Jestem automatycznym asystentem ${owner}. Przekazuję Twoją wiadomość, a ${owner} odpowie osobiście.`,
    hold: (owner) => `Nie mogę niczego potwierdzić ani obiecać — przekazuję to ${owner}.`,
    urgent: (owner) => `To brzmi pilnie. Zadzwoń teraz na pogotowie lub bezpośrednio do ${owner} — nie potrafię działać wystarczająco szybko.`,
    firstContact: (owner) => `Dzień dobry, jestem automatycznym asystentem ${owner}. ${owner} jest teraz niedostępny — napisz, czego potrzebujesz, a przekażę.`,
  },
  id: {
    disclose: (owner) => `Saya asisten otomatis ${owner}. Saya meneruskan pesan Anda dan ${owner} akan membalas secara pribadi.`,
    hold: (owner) => `Saya tidak bisa mengonfirmasi atau menjanjikan apa pun — saya teruskan ini ke ${owner}.`,
    urgent: (owner) => `Ini terdengar mendesak. Segera hubungi layanan darurat atau ${owner} langsung — saya tidak bisa bertindak cukup cepat.`,
    firstContact: (owner) => `Halo, saya asisten otomatis ${owner}. ${owner} sedang tidak tersedia — beri tahu apa yang Anda butuhkan, saya teruskan.`,
  },
};

// A language with no table of its own gets the English sentences rather than a
// crash or a blank message. `partial` is false only when every key is translated,
// so the caller can say so in the log instead of pretending it is localised.
export function hasSafetyTexts(lang) {
  const table = TEXTS[String(lang || 'en').toLowerCase()];
  return Boolean(table) && ['disclose', 'hold', 'urgent', 'firstContact'].every((k) => typeof table[k] === 'function');
}

export function guardTexts(lang) {
  const table = TEXTS[String(lang || 'en').toLowerCase()];
  return table ? { ...TEXTS.en, ...table } : TEXTS.en;
}

export function looksUrgent(text) {
  const s = String(text ?? '');
  return URGENT.some((re) => re.test(s));
}

// Returns { text, replaced, reasons, blocked }.
//   text     - what is safe to send
//   replaced - true if anything was swapped
//   reasons  - machine-readable list ("identity", "commitment", "length")
//   blocked  - true when the whole reply was unusable and replaced wholesale
export function guardOutgoing(answer, { ownerName = 'the owner', lang = 'en', maxChars = 900 } = {}) {
  const t = guardTexts(lang);
  let text = String(answer ?? '').trim();
  const reasons = [];

  if (!text) {
    return { text: t.disclose(ownerName), replaced: true, reasons: ['empty'], blocked: true };
  }

  // 1. Claiming to be the owner. The owner's own name must never appear as "I am X".
  //    "I'm Sam's automated assistant" is the sentence this whole project wants, so
  //    the possessive form followed by the words that disclose is not a claim - it is
  //    the opposite of one. Without this, the guard rewrites the honest reply too.
  const notDisclosure = "(?!['’]s\\s+(?:automated\\s+|ai\\s+)?(?:assistant|secretary|bot|helper))";
  const namePattern = ownerName && ownerName !== 'the owner'
    ? new RegExp(`\\b(i am|i'm|this is|it'?s)\\s+${escapeRe(ownerName)}\\b${notDisclosure}`, 'i')
    : null;
  if (namePattern && namePattern.test(text)) {
    reasons.push('identity');
    text = t.disclose(ownerName);
    return { text, replaced: true, reasons, blocked: true };
  }
  if (OWNER_CLAIM.test(text)) {
    // A generic "I am <something>" that could still be a false display of authority.
    reasons.push('identity-generic');
    text = t.disclose(ownerName);
    return { text, replaced: true, reasons, blocked: true };
  }

  // 2. Commitments: replace the whole reply, not the sentence. A partial edit
  //    leaves a message that no longer makes sense and still sounds like you.
  if (COMMITMENT.some((re) => re.test(text))) {
    reasons.push('commitment');
    text = t.hold(ownerName);
    return { text, replaced: true, reasons, blocked: true };
  }

  // 3. Shape: keep it short and plain. Long lists are a sign the model is
  //    monologuing (and a sign of a bad prompt) in a chat that isn't yours.
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('؟ '));
    text = (stop > maxChars * 0.5 ? cut.slice(0, stop + 1) : cut).trim();
    reasons.push('length');
  }

  return { text, replaced: reasons.length > 0, reasons, blocked: false };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
