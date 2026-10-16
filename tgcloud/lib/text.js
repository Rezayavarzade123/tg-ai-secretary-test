// Pure helpers (no SDK imports) so they can be unit-tested locally.

// Split long text into Telegram-sized pieces, preferring paragraph/line/word breaks.
export function chunk(text, size = 4000) {
  const out = [];
  let rest = String(text ?? '').trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// "/cmd@MyBot some args" -> { cmd: "cmd", arg: "some args" }; null if not a command.
export function parseCommand(text) {
  const m = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec((text || '').trim());
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), arg: (m[2] || '').trim() };
}

// Remove reasoning blocks some models emit inline.
export function stripThink(s) {
  return String(s ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// Current date/time in a timezone. With roundMinutes (e.g. 10) the time is rounded DOWN to that step,
// so the text only changes every 10 minutes and stays identical between messages (better for prompt caching).
// `now` (ms since epoch) is injectable for tests.
export function nowString(tz, roundMinutes = 0, now = Date.now()) {
  const step = roundMinutes > 0 ? roundMinutes * 60000 : 0;
  const d = new Date(step ? Math.floor(now / step) * step : now);
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(d);
  } catch {
    return d.toISOString();
  }
}

export function displayName(u) {
  if (!u) return 'Unknown';
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id);
}

// Replace every "{owner}" placeholder in a custom prompt with the owner's name.
export function fillPrompt(template, ownerName) {
  return String(template ?? '').split('{owner}').join(ownerName);
}

// UTF-8 bytes -> string. Written by hand so it works even if the runtime has no TextDecoder
// (handles Persian, emoji, etc.). Exported separately so it can be tested against TextDecoder.
export function utf8Manual(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++];
    let cp;
    if (b < 0x80) cp = b;
    else if (b >= 0xC0 && b < 0xE0) cp = ((b & 0x1F) << 6) | (bytes[i++] & 0x3F);
    else if (b >= 0xE0 && b < 0xF0) cp = ((b & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
    else if (b >= 0xF0 && b < 0xF8) cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
    else cp = 0xFFFD;
    out += String.fromCodePoint(cp > 0x10FFFF ? 0xFFFD : cp);
  }
  return out;
}

export function decodeUtf8(bytes) {
  if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
  return utf8Manual(bytes);
}

export function errMsg(e) {
  return e?.description ?? e?.message ?? String(e);
}
