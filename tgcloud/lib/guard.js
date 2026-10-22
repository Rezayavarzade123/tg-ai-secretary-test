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
const OWNER_CLAIM = /\b(i am|i'm|this is|it'?s|speaking as)\s+(the\s+)?(owner|boss|manager|admin|administrator|person in charge|authori[sz]ed|real [a-z]+)\b/gi;

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
};

export function guardTexts(lang) {
  return TEXTS[String(lang || 'en').toLowerCase()] ?? TEXTS.en;
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
  const namePattern = ownerName && ownerName !== 'the owner'
    ? new RegExp(`\\b(i am|i'm|this is|it'?s)\\s+${escapeRe(ownerName)}\\b`, 'gi')
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
