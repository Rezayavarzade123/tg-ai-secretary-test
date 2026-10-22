// Quiet hours, in the owner's timezone.
//
// What it is for: an "auto" secretary that answers strangers at 3 a.m. looks like
// an insomniac, and nobody wants the bot committing to something overnight. During
// quiet hours the bot still reads the message and still prepares the reply — it just
// does not send it: the reply becomes a draft you find in the morning.
//
// Pure functions with an injectable clock, so this is testable without waiting
// until bedtime.

// "22", "7", "07", 22 -> 22. Anything else -> null.
export function parseHour(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 23) return null;
  return n;
}

// A pair of settings is valid only when both ends parse and they differ.
// start === end would mean "quiet all day", which is never what someone meant
// with two dropdowns, so it is treated as disabled.
export function parseWindow(start, end) {
  const from = parseHour(start);
  const to = parseHour(end);
  if (from === null || to === null || from === to) return null;
  return { from, to };
}

// Local wall-clock hour (0-23) at `now` in `tz`. Falls back to UTC if the
// timezone is not known to this machine.
export function hourIn(tz, now = Date.now()) {
  const d = new Date(now);
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', hour12: false, timeZone: tz || 'UTC',
    }).formatToParts(d);
    const h = parts.find((p) => p.type === 'hour')?.value;
    const n = Number(h);
    if (Number.isInteger(n)) return n % 24;
  } catch { /* unknown tz */ }
  return d.getUTCHours();
}

export function inQuietHours({ start, end, tz = 'UTC', now = Date.now() }) {
  const win = parseWindow(start, end);
  if (!win) return false;
  const h = hourIn(tz, now);
  return win.from < win.to
    ? h >= win.from && h < win.to        // 09-17: inside the day
    : h >= win.from || h < win.to;       // 22-08: wraps midnight
}

// "22:00–08:00" for messages and the panel.
export function describeWindow(start, end) {
  const win = parseWindow(start, end);
  if (!win) return 'off';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(win.from)}:00–${pad(win.to)}:00`;
}

// The next moment quiet hours end, in hours from now (for a polite message such as
// "I'll draft replies and you'll see them at 08:00").
export function hoursUntilWindowEnd({ start, end, tz = 'UTC', now = Date.now() }) {
  const win = parseWindow(start, end);
  if (!win || !inQuietHours({ start, end, tz, now })) return 0;
  const h = hourIn(tz, now);
  return ((win.to - h) % 24 + 24) % 24 || 24;
}
