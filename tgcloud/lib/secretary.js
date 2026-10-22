import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { secretaryChats } from '../schema.js';
import { DEFAULT_PAUSE_HOURS } from './config.js';
import { ownerId } from './owner.js';
import { getSetting, setSetting } from './settings.js';

const nowSec = () => Math.floor(Date.now() / 1000);

// ---- Which Secretary-mode connections belong to you -------------------------
// (Telegram's API still calls a Secretary-mode connection a "business connection".)

async function readConns() {
  try {
    return JSON.parse(await getSetting('secretary_conns', '[]'));
  } catch {
    return [];
  }
}

export async function addSecretaryConn(id) {
  const ids = await readConns();
  if (!ids.includes(id)) await setSetting('secretary_conns', JSON.stringify([...ids, id]));
}

export async function removeSecretaryConn(id) {
  const ids = await readConns();
  await setSetting('secretary_conns', JSON.stringify(ids.filter((x) => x !== id)));
}

// Only act on connections created by you, so nobody else can attach this
// bot to their own account and burn your Ollama quota.
export async function isSecretaryConnection(connId) {
  if (!connId) return false;
  if ((await readConns()).includes(connId)) return true;
  try {
    const c = await api.getBusinessConnection({ business_connection_id: connId });
    if (c?.user?.id === (await ownerId()) && c.is_enabled !== false) {
      await addSecretaryConn(connId);
      return true;
    }
  } catch (e) {
    console.warn('getBusinessConnection failed:', e?.description ?? e);
  }
  return false;
}

// ---- Per-chat state --------------------------------------------------------

export async function noteContact(chatId, name) {
  await db.insert(secretaryChats)
    .values({ chatId, name })
    .onConflictDoUpdate({ target: secretaryChats.chatId, set: { name } })
    .run();
}

// Called when YOU write manually in a chat: the secretary then stays quiet there for a while.
export async function touchOwnerActive(chatId) {
  const t = nowSec();
  await db.insert(secretaryChats)
    .values({ chatId, ownerLastAt: t })
    .onConflictDoUpdate({ target: secretaryChats.chatId, set: { ownerLastAt: t } })
    .run();
}

export async function shouldReply(chatId) {
  const row = await db.select().from(secretaryChats).where(eq(secretaryChats.chatId, chatId)).get();
  if (row?.muted) return false;
  const hours = Number(await getSetting('pause_hours', String(DEFAULT_PAUSE_HOURS)));
  if (row && row.ownerLastAt && nowSec() - row.ownerLastAt < hours * 3600) return false;
  return true;
}

export async function setMuted(chatId, muted) {
  await db.insert(secretaryChats)
    .values({ chatId, muted })
    .onConflictDoUpdate({ target: secretaryChats.chatId, set: { muted } })
    .run();
}
