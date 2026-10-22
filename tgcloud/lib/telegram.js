import { api } from 'sdk';
import { TYPING_REFRESH_MS } from './config.js';
import { ownerId } from './owner.js';
import { chunk } from './text.js';

// Send plain text (no parse_mode on purpose: model output often breaks Markdown/HTML).
// `extra` can carry business_connection_id (Telegram's API name for a Secretary-mode
// connection) so the reply goes out from your main account.
export async function say(chatId, text, extra = {}) {
  for (const part of chunk(text || '…')) {
    await api.sendMessage({ chat_id: chatId, text: part, ...extra });
  }
}

export async function typing(chatId, businessConnectionId) {
  try {
    const p = { chat_id: chatId, action: 'typing' };
    if (businessConnectionId) p.business_connection_id = businessConnectionId;
    await api.sendChatAction(p);
  } catch (e) {
    // cosmetic only
  }
}

// Keep the "typing..." indicator visible while `work` runs (e.g. waiting for the model).
// Telegram clears it after ~5 s, so it is re-sent every `everyMs`. It stops as soon as `work`
// finishes or fails, and a failing indicator never breaks the real work.
// Without timers in the runtime it shows once, like before.
export async function withTyping(chatId, businessConnectionId, work, everyMs = TYPING_REFRESH_MS) {
  await typing(chatId, businessConnectionId);
  if (typeof setInterval !== 'function') return work();
  const timer = setInterval(() => { typing(chatId, businessConnectionId); }, everyMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

// Message the owner without ever letting a failure break the main flow.
export async function tellOwner(text) {
  try {
    const owner = await ownerId();
    if (!owner) return;
    await say(owner, text);
  } catch (e) {
    console.warn('tellOwner failed:', e?.description ?? e);
  }
}
