// Minimal Bot API client: plain HTTPS calls to api.telegram.org, no SDK.
//
// The token is read on every call, so changing it in the control panel takes
// effect without a restart.

const API_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

export function botToken() {
  return process.env.BOT_TOKEN || '';
}

export function setBotToken(token) {
  process.env.BOT_TOKEN = String(token || '');
}

export class TelegramError extends Error {
  constructor(method, status, description, parameters) {
    super(description || `Telegram ${method} failed (HTTP ${status})`);
    this.name = 'TelegramError';
    this.method = method;
    this.status = status;
    this.description = description;
    this.parameters = parameters;
  }
}

async function call(method, params = {}, { timeoutMs = 45000 } = {}) {
  const token = botToken();
  if (!token) throw new TelegramError(method, 0, 'No bot token configured. Put BOT_TOKEN in bot/.env or set it in the control panel.');

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();

  let res;
  try {
    res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller?.signal,
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    const why = e?.name === 'AbortError' ? 'the request timed out' : (e?.cause?.code || e?.message || String(e));
    throw new TelegramError(method, 0, `Cannot reach Telegram (${why}). Check the network/DNS on this machine.`);
  }
  if (timer) clearTimeout(timer);

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }

  if (!res.ok || data?.ok === false) {
    throw new TelegramError(method, res.status, data?.description || `HTTP ${res.status}`, data?.parameters);
  }
  return data?.result;
}

export const api = {
  call,
  getMe: () => call('getMe'),
  deleteWebhook: (params = {}) => call('deleteWebhook', params),
  getUpdates: (params = {}) => call('getUpdates', { timeout: 30, ...params }, { timeoutMs: ((params.timeout ?? 30) + 15) * 1000 }),
  setMyCommands: (commands) => call('setMyCommands', { commands }),

  sendMessage: (params) => call('sendMessage', { parse_mode: undefined, ...params }),
  editMessageText: (params) => call('editMessageText', { parse_mode: undefined, ...params }),
  editMessageReplyMarkup: (params) => call('editMessageReplyMarkup', params),
  deleteMessage: (params) => call('deleteMessage', params),
  sendChatAction: (params) => call('sendChatAction', params),
  answerCallbackQuery: (params) => call('answerCallbackQuery', params),

  getBusinessConnection: (params) => call('getBusinessConnection', params),

  getFile: (params) => call('getFile', params),
  async getFileContent(fileId) {
    const f = await call('getFile', { file_id: fileId });
    const url = `${API_BASE}/file/bot${botToken()}/${f.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Telegram file download failed (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  },
};
