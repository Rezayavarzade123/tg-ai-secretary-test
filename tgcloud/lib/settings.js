import { db } from 'sdk';
import { eq } from 'sdk/db';
import { settings } from '../schema.js';

// Settings were renamed when the project switched to Telegram's "Secretary mode" wording.
// If an old key is still stored (from an earlier deploy), it is read as a fallback, so
// nothing you already saved is lost. New values are always written under the new name.
const LEGACY_KEYS = {
  secretary: 'biz',
  secretary_info: 'biz_info',
  secretary_conns: 'owner_conns',
  prompt_secretary: 'prompt_biz',
  prompt_bot: 'prompt_owner',
};

async function readRaw(key) {
  const row = await db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? row.value : null;
}

export async function getSetting(key, fallback = null) {
  const value = await readRaw(key);
  if (value !== null) return value;
  const legacy = LEGACY_KEYS[key];
  if (legacy) {
    const old = await readRaw(legacy);
    if (old !== null) return old;
  }
  return fallback;
}

export async function setSetting(key, value) {
  await db.insert(settings)
    .values({ key, value: String(value) })
    .onConflictDoUpdate({ target: settings.key, set: { value: String(value) } })
    .run();
}

// Deletes the new key AND its legacy twin, so a reset can't be undone by an old value.
export async function delSetting(key) {
  await db.delete(settings).where(eq(settings.key, key)).run();
  const legacy = LEGACY_KEYS[key];
  if (legacy) await db.delete(settings).where(eq(settings.key, legacy)).run();
}
