import { db, api } from 'sdk';
import { eq, desc } from 'sdk/db';
import { drafts } from '../schema.js';
import { ownerId } from './owner.js';
import { say } from './telegram.js';
import { logActivity } from './activity.js';
import { guardOutgoing } from './guard.js';
import { respond, rememberExchange } from './brain.js';
import { language, languagePromptName } from './lang.js';

// Draft mode: the bot writes the reply, you approve it.
//
// The draft lives in the database, so it can be approved from the Telegram card
// OR from the control panel — both call the same functions. Every send goes
// through here, which is also where the last safety check happens.

const nowSec = () => Math.floor(Date.now() / 1000);

export async function saveDraft({ chatId, connId, name, incoming, answer, reasons = [], lang = 'en' }) {
  const [row] = await db.insert(drafts).values({
    chatId,
    connId,
    name: name ?? 'Unknown',
    incoming,
    answer,
    lang,
    guard: JSON.stringify(reasons),
    status: 'pending',
    created: nowSec(),
  }).returning().run();
  await logActivity('draft', `Draft for ${name} (chat ${chatId})${reasons.length ? ` — guards: ${reasons.join(', ')}` : ''}`);
  return row;
}

export async function countPendingDrafts() {
  const rows = await db.select({ id: drafts.id }).from(drafts).where(eq(drafts.status, 'pending')).all();
  return rows.length;
}

export async function getDraft(id) {
  return db.select().from(drafts).where(eq(drafts.id, Number(id))).get();
}

export async function listDrafts({ status = 'pending', limit = 20 } = {}) {
  let q = db.select().from(drafts);
  if (status && status !== 'all') q = q.where(eq(drafts.status, status));
  return q.orderBy(desc(drafts.id)).limit(limit).all();
}

export async function updateDraftText(id, text, { reasons = [] } = {}) {
  await db.insert(drafts)
    .values({ id: Number(id), answer: text, guard: JSON.stringify(reasons) })
    .onConflictDoUpdate({ target: drafts.id, set: { answer: text, guard: JSON.stringify(reasons) } })
    .run();
  const d = await getDraft(id);
  if (d?.ownerMsgId) {
    try {
      await api.editMessageText({ chat_id: await ownerId(), message_id: d.ownerMsgId, text: cardText(d), reply_markup: keyboard(d.id) });
    } catch { /* the card may be too old to edit; the panel still has it */ }
  }
  return d;
}

// --- the card in your Telegram chat --------------------------------------------

export function cardText(d) {
  const reasons = safeJson(d.guard);
  const why = reasons.length ? `\n🛡 Safety net replaced the model's wording: ${reasons.join(', ')}` : '';
  const incoming = String(d.incoming).slice(0, 700);
  const answer = String(d.answer).slice(0, 900);
  return [
    `📝 Draft reply — ${d.name} (chat ${d.chatId})`,
    ``,
    `They wrote:`,
    incoming,
    ``,
    `Draft${d.lang ? ` [${languagePromptName(d.lang)}]` : ''}:`,
    answer,
    why,
    ``,
    `Send it, regenerate, or ignore. You can also edit it in the control panel.`,
  ].join('\n');
}

function keyboard(id) {
  return {
    inline_keyboard: [[
      { text: '✅ Send', callback_data: `d:${id}:send` },
      { text: '🔁 Regenerate', callback_data: `d:${id}:regen` },
      { text: '🚫 Ignore', callback_data: `d:${id}:ignore` },
    ]],
  };
}

// Message the owner with the draft card. Never throws: a failed notification must
// not lose the draft (it stays visible in the panel).
export async function notifyOwner(draft) {
  const owner = await ownerId();
  if (!owner) return null;
  try {
    const res = await api.sendMessage({
      chat_id: owner,
      text: cardText(draft),
      reply_markup: keyboard(draft.id),
    });
    const msgId = res?.message_id;
    if (msgId) {
      await db.insert(drafts).values({ id: draft.id, ownerMsgId: msgId })
        .onConflictDoUpdate({ target: drafts.id, set: { ownerMsgId: msgId } }).run();
    }
    return msgId ?? null;
  } catch (e) {
    await logActivity('error', `Could not send the draft card: ${e?.description ?? e?.message ?? e}`);
    return null;
  }
}

// --- actions -------------------------------------------------------------------

export async function sendDraft(id, { text } = {}) {
  const d = await getDraft(id);
  if (!d) throw new Error('Draft not found.');
  if (d.status !== 'pending') throw new Error(`This draft is already ${d.status}.`);

  const finalText = String(text ?? d.answer).trim();
  if (!finalText) throw new Error('The draft is empty.');

  // Last line of defence: run the text through the guards again, even if you edited it.
  const guarded = guardOutgoing(finalText, { ownerName: await ownerNameSafe(), lang: d.lang });
  const sendText = guarded.blocked ? guarded.text : finalText;

  await say(d.chatId, sendText, { business_connection_id: d.connId });
  await db.insert(drafts).values({ id: d.id, status: 'sent', sentText: sendText })
    .onConflictDoUpdate({ target: drafts.id, set: { status: 'sent', sentText: sendText, answer: sendText } })
    .run();
  await rememberExchange(`secretary:${d.chatId}`, d.incoming, sendText);
  await logActivity('sent', `Sent to ${d.name} (chat ${d.chatId})${guarded.reasons.length ? ` — guards: ${guarded.reasons.join(', ')}` : ''}`);
  return { ...d, status: 'sent', sentText: sendText, guardReasons: guarded.reasons };
}

export async function ignoreDraft(id) {
  const d = await getDraft(id);
  if (!d) throw new Error('Draft not found.');
  await db.insert(drafts).values({ id: d.id, status: 'ignored' })
    .onConflictDoUpdate({ target: drafts.id, set: { status: 'ignored', resolved: nowSec() } }).run();
  await logActivity('info', `Ignored the draft for ${d.name} (chat ${d.chatId})`);
  return d;
}

export async function regenerateDraft(id) {
  const d = await getDraft(id);
  if (!d) throw new Error('Draft not found.');
  if (d.status !== 'pending') throw new Error(`This draft is already ${d.status}.`);

  const raw = await respond({ scope: `secretary:${d.chatId}`, userText: d.incoming, mode: 'secretary', remember: false });
  const guarded = guardOutgoing(raw, { ownerName: await ownerNameSafe(), lang: d.lang });
  await db.insert(drafts).values({ id: d.id, answer: guarded.text, guard: JSON.stringify(guarded.reasons) })
    .onConflictDoUpdate({ target: drafts.id, set: { answer: guarded.text, guard: JSON.stringify(guarded.reasons) } }).run();
  const fresh = await getDraft(id);
  if (fresh?.ownerMsgId) {
    try {
      await api.editMessageText({ chat_id: await ownerId(), message_id: fresh.ownerMsgId, text: cardText(fresh), reply_markup: keyboard(fresh.id) });
    } catch { /* ignore */ }
  }
  return fresh;
}

async function ownerNameSafe() {
  const { getSetting } = await import('./settings.js');
  return getSetting('owner_name', 'the owner');
}

// Telegram inline-button presses. Returns true if the update was ours.
export async function handleDraftCallback(query) {
  const data = String(query?.data ?? '');
  if (!data.startsWith('d:')) return false;

  const [, rawId, action] = data.split(':');
  const id = Number(rawId);
  const owner = await ownerId();
  const from = query?.from?.id;

  const answer = (text, showAlert = false) =>
    api.answerCallbackQuery({ callback_query_id: query.id, text, show_alert: showAlert }).catch(() => {});

  if (!owner || Number(from) !== Number(owner)) {
    await answer('Only the owner can do that.', true);
    return true;
  }

  const d = await getDraft(id);
  if (!d) { await answer('That draft no longer exists.', true); return true; }
  if (d.status !== 'pending') { await answer(`Already ${d.status}.`, true); return true; }

  try {
    if (action === 'send') {
      await sendDraft(id);
      await answer('Sent ✅');
    } else if (action === 'ignore') {
      await ignoreDraft(id);
      await answer('Ignored');
    } else if (action === 'regen') {
      await answer('Regenerating…');
      await regenerateDraft(id);
    } else {
      await answer('Unknown action.', true);
      return true;
    }

    // Update the card in place so the chat does not fill with old drafts.
    const after = await getDraft(id);
    if (after?.ownerMsgId) {
      const status = after.status === 'sent' ? '✅ SENT' : after.status === 'ignored' ? '🚫 IGNORED' : null;
      const text = status
        ? `${status} — ${after.name} (chat ${after.chatId})\n\n${String(after.sentText ?? after.answer).slice(0, 900)}`
        : cardText(after);
      const extra = status ? { reply_markup: { inline_keyboard: [] } } : { reply_markup: keyboard(after.id) };
      await api.editMessageText({ chat_id: owner, message_id: after.ownerMsgId, text, ...extra }).catch(() => {});
    }
  } catch (e) {
    await answer(e?.message ?? String(e), true);
    await logActivity('error', `Draft action "${action}" failed: ${e?.message ?? e}`);
  }
  return true;
}

function safeJson(s) {
  try { return JSON.parse(s || '[]'); } catch { return []; }
}

// Small helper used by the panel: the languages we can name for a draft.
export function draftLangLabel(code) {
  return language(code)?.label ?? code ?? 'unknown';
}
