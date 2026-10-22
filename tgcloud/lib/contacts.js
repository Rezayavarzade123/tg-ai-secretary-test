import { db } from 'sdk';
import { eq, desc } from 'sdk/db';
import { secretaryChats } from '../schema.js';
import { logActivity } from './activity.js';
import { isLanguageInput, resolveLanguage } from './lang.js';

// Per-chat context and controls for Secretary mode.
//
// Why this matters more than it sounds: a 1–2B model cannot remember that "Sara"
// is your sister, that "the office" is a specific number, or that Reza only writes
// in Persian. Three lines of owner-written context do more for reply quality than
// a bigger model, and they cost a few prompt tokens.
//
// Notes are written by the owner, so they are trusted — unlike anything the sender
// writes, which is never treated as instructions.

export const NOTES_LIMIT = 400;

const nowSec = () => Math.floor(Date.now() / 1000);

// Rows written before these columns existed (or by a runtime that does not apply
// column defaults) come back with undefined fields. Normalising on read keeps
// `if (contact.blocked)` honest everywhere.
function normalize(row) {
  if (!row) return null;
  return {
    ...row,
    notes: row.notes ?? '',
    // A row written by an older build may hold a name ("Swedish") instead of a code.
    // Resolving on read means the prompt, the guard and the panel all agree on it.
    lang: row.lang ? (isLanguageInput(row.lang) ? resolveLanguage(row.lang).code : '') : '',
    blocked: Boolean(row.blocked),
    muted: Boolean(row.muted),
    ownerLastAt: row.ownerLastAt ?? 0,
    lastSeenAt: row.lastSeenAt ?? 0,
  };
}

export async function getContact(chatId) {
  const row = await db.select().from(secretaryChats).where(eq(secretaryChats.chatId, Number(chatId))).get();
  return normalize(row);
}

export async function listContacts(limit = 50) {
  const rows = await db.select().from(secretaryChats).orderBy(desc(secretaryChats.lastSeenAt)).limit(limit).all();
  // Chats with no lastSeenAt (older rows) go last but are still listed.
  return rows.map(normalize).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
}

export async function updateContact(chatId, patch = {}) {
  const id = Number(chatId);
  if (!Number.isInteger(id)) throw new Error('A chat id is a number.');

  const set = {};
  if ('notes' in patch) {
    const notes = String(patch.notes ?? '').trim();
    if (notes.length > NOTES_LIMIT) throw new Error(`Keep the notes under ${NOTES_LIMIT} characters.`);
    set.notes = notes;
  }
  if ('lang' in patch) {
    const lang = String(patch.lang ?? '').trim().toLowerCase();
    set.lang = lang === '' || lang === 'auto' ? '' : lang;
  }
  if ('blocked' in patch) set.blocked = Boolean(patch.blocked);
  if ('muted' in patch) set.muted = Boolean(patch.muted);
  if (!Object.keys(set).length) throw new Error('Nothing to update.');

  const existing = await getContact(id);
  if (!existing) {
    await db.insert(secretaryChats).values({
      chatId: id, notes: '', lang: '', blocked: false, muted: false, ownerLastAt: 0, ...set, lastSeenAt: nowSec(),
    }).run();
  } else {
    await db.insert(secretaryChats).values({ chatId: id, ...set })
      .onConflictDoUpdate({ target: secretaryChats.chatId, set }).run();
  }

  const what = Object.keys(set).join(', ');
  await logActivity('info', `Contact ${id}: ${what} updated`);
  return getContact(id);
}

export async function markSeen(chatId, name) {
  const id = Number(chatId);
  const t = nowSec();
  const existing = await getContact(id);
  if (!existing) {
    await db.insert(secretaryChats).values({
      chatId: id, name, notes: '', lang: '', blocked: false, muted: false, ownerLastAt: 0, lastSeenAt: t,
    }).run();
    return;
  }
  const set = { lastSeenAt: t };
  if (name && name !== existing.name) set.name = name;
  await db.insert(secretaryChats).values({ chatId: id, ...set })
    .onConflictDoUpdate({ target: secretaryChats.chatId, set }).run();
}

export async function isBlocked(chatId) {
  const c = await getContact(chatId);
  return Boolean(c?.blocked);
}

// The one line added to the secretary prompt for this chat, or '' when there is
// nothing to say. Deliberately labelled as owner-written so the model does not
// mistake it for something the sender said.
export function contactPromptLine(contact) {
  if (!contact?.notes) return '';
  return `What ${'the owner'} knows about this sender (written by the owner, trusted): ${contact.notes}`;
}

// Which language to answer this chat in.
//   contact lang  -> always that (owner override)
//   auto on       -> the detected language of the message
//   auto off      -> the global setting
export function langForContact(contact, { auto, fallback, detected }) {
  if (contact?.lang) return contact.lang;
  if (auto) return detected || fallback;
  return fallback;
}
