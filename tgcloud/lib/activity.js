import { db } from 'sdk';
import { desc, lte } from 'sdk/db';
import { activity } from '../schema.js';

const nowSec = () => Math.floor(Date.now() / 1000);
const KEEP = 300;

// A log that never breaks the caller: used all over the bot, and a logging
// failure must never cost a reply.
export async function logActivity(kind, summary) {
  try {
    await db.insert(activity).values({ at: nowSec(), kind, summary: String(summary).slice(0, 500) }).run();
    // Occasionally trim, so the table cannot grow forever on a machine that runs for months.
    if (Math.random() < 0.05) {
      const cutoff = await db.select({ id: activity.id }).from(activity)
        .orderBy(desc(activity.id)).limit(1).offset(KEEP).get();
      if (cutoff) await db.delete(activity).where(lte(activity.id, cutoff.id)).run();
    }
  } catch (e) {
    console.warn('logActivity failed:', e?.message ?? e);
  }
}

export async function recentActivity(limit = 50) {
  const rows = await db.select().from(activity).orderBy(desc(activity.id)).limit(limit).all();
  return rows;
}
