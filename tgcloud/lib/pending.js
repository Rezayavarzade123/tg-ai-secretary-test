import { db } from 'sdk';
import { eq, and, desc, asc, lte } from 'sdk/db';
import { pending } from '../schema.js';

const nowSec = () => Math.floor(Date.now() / 1000);
const STALE_SECONDS = 15 * 60;   // fragments older than this are never merged into a reply

// Store one incoming fragment and return its id. Everything is keyed by chat_id,
// so every person has an independent queue and timer.
export async function queueFragment({ chatId, connId, name, text }) {
  const [row] = await db.insert(pending)
    .values({ chatId, connId, name, text, at: nowSec() })
    .returning()
    .run();
  return row.id;
}

// Called by each fragment's invocation after its wait is over.
// Only the invocation holding this chat's NEWEST fragment gets a batch; the
// invocations of earlier fragments get null and simply end. The winner takes
// every fragment up to its own id, merged into one text.
export async function claimBatch(chatId, myId) {
  const latest = await db.select({ id: pending.id }).from(pending)
    .where(eq(pending.chatId, chatId))
    .orderBy(desc(pending.id))
    .limit(1)
    .get();
  if (!latest || latest.id !== myId) return null;

  const rows = await db.select().from(pending)
    .where(and(eq(pending.chatId, chatId), lte(pending.id, myId)))
    .orderBy(asc(pending.id))
    .all();
  await db.delete(pending)
    .where(and(eq(pending.chatId, chatId), lte(pending.id, myId)))
    .run();

  const fresh = rows.filter((r) => r.at >= nowSec() - STALE_SECONDS);
  if (!fresh.length) return null;
  return {
    text: fresh.map((r) => r.text).join('\n'),
    connId: rows[rows.length - 1].connId,
    name: rows[rows.length - 1].name,
    count: fresh.length,
  };
}

// Drop everything queued for a chat (e.g. you answered it yourself).
export async function clearPending(chatId) {
  await db.delete(pending).where(eq(pending.chatId, chatId)).run();
}
