import { say } from './telegram.js';
import { getContact } from './contacts.js';
import { getSetting } from './settings.js';
import { guardOutgoing } from './guard.js';
import { ownerName } from './owner.js';
import { logActivity } from './activity.js';

// Writing to somebody from your own account, because you asked for it.
//
// This is the one path where a message leaves the account without a draft, and it is
// the owner who asks for it, one message at a time: /send <who> <text>. Everything
// else in this project still drafts first. There is no model here - the words are the
// owner's, and a 1-2B model has no business choosing who hears from them.
//
// Telegram calls the connection a "business connection". That id is what makes the
// message appear from the account instead of from the bot, and Telegram only offers it
// for chats the account already has, which is why "I cannot write to a stranger" is a
// limit of the platform, not a setting.

export const SEND_USAGE = [
  'Usage: /send <name or chat id> <text>',
  '  /send Ali running 10 minutes late',
  '  /send 123456789 see you at six',
  'Names come from /contacts — people who have written to your account.',
].join('\n');

// The connection id of the owner's account, as recorded when the bot was attached.
export async function secretaryConnId() {
  try {
    const ids = JSON.parse(await getSetting('secretary_conns', '[]'));
    return Array.isArray(ids) && ids.length ? ids[0] : null;
  } catch {
    return null;
  }
}

// People who can be written to: the ids Telegram has already shown us.
function rank(people, query) {
  const q = query.toLowerCase();
  const named = people.filter((p) => p && p.name);
  const exact = named.filter((p) => String(p.name).toLowerCase() === q);
  if (exact.length) return exact;
  const starts = named.filter((p) => String(p.name).toLowerCase().startsWith(q));
  if (starts.length) return starts;
  return named.filter((p) => String(p.name).toLowerCase().includes(q));
}

const sameChat = (list) => list.filter((p, i) => list.findIndex((x) => x.chatId === p.chatId) === i);

// Turn "/send Ali running late" into { chatId, name, text } without guessing too much.
// The name is the longest prefix (up to three words) that matches exactly one known
// person, so "Ali Reza" wins over "Ali" when both are in the list. Ambiguity is
// reported, never resolved by picking the first row.
export function parseSendCommand(people, arg) {
  const rest = String(arg ?? '').trim();
  if (!rest) return { kind: 'usage' };
  // A name with nothing after it is a half-typed command, not an unknown person.
  if (!/\s/.test(rest)) return { kind: 'usage' };

  // 1. An explicit id, the form /contacts prints.
  const byId = /^(-?\d{3,})\s+([\s\S]+)$/.exec(rest);
  if (byId) {
    const chatId = Number(byId[1]);
    const known = people.find((p) => Number(p.chatId) === chatId);
    return { kind: 'send', chatId, name: known?.name || '', text: byId[2].trim() };
  }

  // 2. A quoted name, for anyone whose name the owner wants to type in full.
  const quoted = /^["“'«]([^"”'»]+)["”'»]\s+([\s\S]+)$/.exec(rest);
  if (quoted) {
    const matches = sameChat(rank(people, quoted[1].trim()));
    if (matches.length === 1) {
      return { kind: 'send', chatId: Number(matches[0].chatId), name: matches[0].name, text: quoted[2].trim() };
    }
    if (matches.length > 1) return { kind: 'many', query: quoted[1].trim(), people: matches };
    return { kind: 'none', query: quoted[1].trim() };
  }

  // 3. A name, as many words as it takes (but leave at least one word for the text).
  const tokens = rest.split(/\s+/);
  for (let n = Math.min(3, tokens.length - 1); n >= 1; n -= 1) {
    const query = tokens.slice(0, n).join(' ');
    const matches = sameChat(rank(people, query));
    if (matches.length === 1) {
      // Take the text from the original string, not from the tokens: line breaks and
      // double spaces are the owner's, and Telegram will render them.
      const text = rest.replace(new RegExp(`^(?:\\S+\\s+){${n}}`), '').trim();
      return { kind: 'send', chatId: Number(matches[0].chatId), name: matches[0].name, text };
    }
    if (matches.length > 1) return { kind: 'many', query, people: matches };
  }
  return { kind: 'none', query: tokens[0] };
}

// Send it. The guards still run, exactly as they do for an edited draft: nothing
// leaves the account unchecked. If a guard rewrites the text, the caller says so - the
// owner must never be told something was sent that was not.
export async function sendAsOwner(chatId, text) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('There is nothing to send.');

  const connId = await secretaryConnId();
  if (!connId) {
    throw new Error('I have no Secretary-mode connection yet, so I cannot write from your account. In Telegram: Settings → Business → Chatbots, connect this bot and let it reply.');
  }

  const id = Number(chatId);
  if (!Number.isInteger(id)) throw new Error('A chat id is a number.');

  const contact = await getContact(id);
  if (contact?.blocked) throw new Error(`That person is blocked, so I will not write to them. /unblock ${id} first.`);

  const guarded = guardOutgoing(body, { ownerName: await ownerName(), lang: contact?.lang || undefined });
  const sent = guarded.blocked ? guarded.text : body;

  await say(id, sent, { business_connection_id: connId });
  await logActivity('sent', `You asked me to write to ${contact?.name || `chat ${id}`}`);
  return { text: sent, reasons: guarded.reasons || [], replaced: Boolean(guarded.blocked) };
}
