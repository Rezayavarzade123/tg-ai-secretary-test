import { api } from 'sdk';
import { getSetting } from './settings.js';

// Group chats.
//
// Two different things are called "groups" and only one of them can work:
//
//   * Secretary mode never applies to a group. Telegram delivers business
//     connections (your account's chats answered by the bot) for private chats
//     only, and there is no API to post into a group as you. Nothing here can
//     change that.
//   * Bot mode *can* answer in a group, because there the bot speaks as itself.
//     That is what this file is about: the bot answers when it is addressed
//     (a mention, a reply to it, or /command@botname) and stays silent otherwise.
//
// Answering only when addressed is not cosmetic. A bot that reacts to every
// message in a busy group is a nuisance, it burns model calls on other people's
// conversation, and on a CPU-only box each reply is seconds of latency. So the
// gate is deterministic and lives in code, before the model is ever called.
//
// Operator note: for a bot with privacy mode ON (the BotFather default) Telegram
// only delivers commands and replies to the bot — not mentions. To be mentionable,
// either turn privacy mode off in /setprivacy, or make the bot an admin of the
// group. The bot says this itself if it never sees a mention that should exist.

const GROUP_TYPES = new Set(['group', 'supergroup']);

export function isGroupChat(type) {
  return GROUP_TYPES.has(String(type || ''));
}

// Who am I? Cached: getMe() once per process, then a stored fallback so a group
// message can still be interpreted while Telegram is unreachable.
let identity = null;

export async function botIdentity() {
  if (identity?.id) return identity;
  try {
    const me = await api.getMe();
    if (me?.id) identity = { id: Number(me.id), username: String(me.username || '').toLowerCase() };
  } catch { /* offline: fall back to what the panel stored */ }
  if (!identity?.id) {
    const id = Number(await getSetting('bot_id', '0'));
    const username = String(await getSetting('bot_username', '')).toLowerCase();
    if (id) identity = { id, username };
  }
  return identity ?? { id: 0, username: '' };
}

// Test seam: forget the cached identity.
export function resetIdentity() {
  identity = null;
}

// Does this message address the bot?
//
//   reply to one of its messages        -> yes
//   @username somewhere in the text     -> yes (mention entity or plain text)
//   text_mention entity for its user id -> yes (bots can be mentioned by name)
//   /command@username                   -> yes
//
// Anything else, including a plain message in the group, is not for the bot.
export function addressesBot(message, me) {
  if (!me?.id) return false;
  const text = String(message?.text ?? message?.caption ?? '');

  if (message?.reply_to_message?.from?.id === me.id) return true;

  for (const e of message?.entities ?? []) {
    if (e.type === 'text_mention' && e.user?.id === me.id) return true;
    if (e.type === 'mention' && me.username) {
      const mentioned = text.slice(e.offset, e.offset + e.length).toLowerCase();
      if (mentioned === `@${me.username}`) return true;
    }
  }

  if (me.username) {
    // Covers a mention with no entity (some clients omit it) and /cmd@botname.
    const pattern = new RegExp(`(^|\\s)@${escapeRegExp(me.username)}\\b`, 'i');
    if (pattern.test(text)) return true;
    const command = new RegExp(`^/\\w+@${escapeRegExp(me.username)}\\b`, 'i');
    if (command.test(text)) return true;
  }
  return false;
}

// Remove the @mention so the model does not see "@mybot" as part of the question.
export function stripAddress(text, me) {
  let out = String(text || '');
  if (me?.username) {
    out = out.replace(new RegExp(`@${escapeRegExp(me.username)}\\b`, 'gi'), ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

// A private chat and a group must not share memory: the same question in two
// places has two different audiences.
export function historyScope(chat) {
  const id = chat?.id;
  if (isGroupChat(chat?.type)) return `group:${id}`;
  return 'bot';
}

export async function groupMode() {
  const v = await getSetting('group_mode', 'on');
  return v === 'off' ? 'off' : 'on';
}

// Forum topics: a reply belongs in the thread the question came from.
export function threadExtra(message) {
  const id = message?.message_thread_id;
  return message?.is_topic_message && id ? { message_thread_id: id } : {};
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
