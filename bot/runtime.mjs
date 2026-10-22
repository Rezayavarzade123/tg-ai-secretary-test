// State shared between the bot loop and the control panel (same process).

export const runtime = {
  startedAt: Date.now(),
  polling: false,
  lastUpdateAt: 0,
  lastError: null,
  lastErrorAt: 0,
  counts: { message: 0, business_message: 0, business_connection: 0, callback_query: 0, inline_query: 0, other: 0 },
  bot: null,            // getMe() result
  panelUrl: '',         // includes the access token (this process only)
  panelUrlPublic: '',   // safe to store and share on the LAN
  panelAvailable: true, // false when the port could not be bound
  log: [],              // last N log lines, for the panel
  onTokenChange: null,  // set by runner.mjs
  onRestart: null,
};

export function noteUpdate(kind) {
  runtime.lastUpdateAt = Date.now();
  runtime.counts[kind] = (runtime.counts[kind] ?? 0) + 1;
}

export function noteError(where, err) {
  runtime.lastError = `${where}: ${err?.description ?? err?.message ?? err}`;
  runtime.lastErrorAt = Date.now();
}

export function log(kind, message) {
  const line = { at: Date.now(), kind, message: String(message) };
  runtime.log.push(line);
  if (runtime.log.length > 200) runtime.log.shift();
  const stamp = new Date(line.at).toISOString().slice(11, 19);
  const prefix = kind === 'error' ? '✖' : kind === 'warn' ? '!' : '·';
  console.log(`${stamp} ${prefix} ${line.message}`);
  return line;
}

export function uptimeSeconds() {
  return Math.floor((Date.now() - runtime.startedAt) / 1000);
}
