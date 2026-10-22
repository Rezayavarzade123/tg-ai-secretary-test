import { db, api } from 'sdk';
import { eq, desc } from 'sdk/db';
import { drafts } from '../schema.js';
import { ownerId } from './owner.js';
import { getSetting } from './settings.js';
import { say } from './telegram.js';
import { logActivity } from './activity.js';
import { guardOutgoing } from './guard.js';
import { respond, rememberExchange } from './brain.js';
import { language, languagePromptName } from './lang.js';

// Draft mode: the bot writes the reply, you approve it.
//
// A draft lives in the database, so it can be approved from the Telegram card OR
// from the control panel — both call the same functions here. Two consequences
// that are easy to get wrong:
//   * every action must update the Telegram card as well, otherwise the card you
//     look at in Telegram disagrees with what actually happened;
//   * a draft that is no longer pending is a record, not a draft: it must not be
//     edited, resent or silently rewritten.

const nowSec = () => Math.floor(Date.now() / 1000);

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

// Bring the Telegram card in line with the database after any change.
async function refreshCard(id) {
  const d = await getDraft(id);
  if (!d?.ownerMsgId) return;
  const owner = await ownerId();
  if (!owner) return;
  const text = d.status === 'pending'
    ? cardText(d)
    : `${d.status === 'sent' ? '✅ SENT' : '🚫 IGNORED'} — ${d.name} (chat ${d.chatId})\n\n${String(d.sentText ?? d.answer).slice(0, 900)}`;
  const extra = d.status === 'pending' ? { reply_markup: keyboard(d.id) } : { reply_markup: { inline_keyboard: [] } };
  try {
    await api.editMessageText({ chat_id: owner, message_id: d.ownerMsgId, text, ...extra });
  } catch {
    // The card may be too old to edit (Telegram keeps ~48 h) or already gone.
    // Not an error worth surfacing: the panel is the source of truth.
  }
}

// Message the owner with the draft card. Never throws: a failed notification must
// not lose the draft (it stays visible in the panel).
export async function notifyOwner(draft) {
  const owner = await ownerId();
  if (!owner) return null;
  try {
    const res = await api.sendMessage({ chat_id: owner, text: cardText(draft), reply_markup: keyboard(draft.id) });
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

export async function updateDraftText(id, text, { reasons = [] } = {}) {
  const d = await getDraft(id);
  if (!d) throw new Error('Draft not found.');
  if (d.status !== 'pending') throw new Error(`This draft was already ${d.status} — it cannot be edited.`);
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('The draft is empty.');
  await db.insert(drafts).values({ id: d.id, answer: trimmed, guard: JSON.stringify(reasons) })
    .onConflictDoUpdate({ target: drafts.id, set: { answer: trimmed, guard: JSON.stringify(reasons) } }).run();
  await refreshCard(d.id);
  return getDraft(d.id);
}

export async function sendDraft(id, { text } = {}) {
  const d = await getDraft(id);
  if (!d) throw new Error('Draft not found.');
  if (d.status !== 'pending') throw new Error(`This draft is already ${d.status}.`);

  const finalText = String(text ?? d.answer).trim();
  if (!finalText) throw new Error('The draft is empty.');

  // Last line of defence: run the text through the guards again, even if you edited it.
  const ownerName = await getSetting('owner_name', 'the owner');
  const guarded = guardOutgoing(finalText, { ownerName, lang: d.lang });
  const sendText = guarded.blocked ? guarded.text : finalText;

  await say(d.chatId, sendText, { business_connection_id: d.connId });
  const resolved = nowSec();
  await db.insert(drafts).values({ id: d.id, status: 'sent', sentText: sendText, resolved })
    .onConflictDoUpdate({ target: drafts.id, set: { status: 'sent', sentText: sendText, answer: sendText, resolved } })
    .run();
  await rememberExchange(`secretary:${d.chatId}`, d.incoming, sendText);
  await logActivity('sent', `Sent to ${d.name} (chat ${d.chatId})${guarded.reasons.length ? ` — guards: ${guarded.reasons.join(', ')}` : ''}`);
  await refreshCard(d.id);
  return { ...d, status: 'sent', sentText: sendText, guardReasons: guarded.reasons };
}

export async function ignoreDraft(id) {
  const d = await getDraft(id);
  if (!d) throw new Error('Draft not found.');
  if (d.status !== 'pending') throw new Error(`This draft is already ${d.status}.`);
  const resolved = nowSec();
  await db.insert(drafts).values({ id: d.id, status: 'ignored', resolved })
    .onConflictDoUpdate({ target: drafts.id, set: { status: 'ignored', resolved } }).run();
  await logActivity('info', `Ignored the draft for ${d.name} (chat ${d.chatId})`);
  await refreshCard(d.id);
  return d;
}

export async function regenerateDraft(id) {
  const d = await getDraft(id);
  if (!d) throw new Error('Draft not found.');
  if (d.status !== 'pending') throw new Error(`This draft is already ${d.status}.`);

  const ownerName = await getSetting('owner_name', 'the owner');
  const raw = await respond({ scope: `secretary:${d.chatId}`, userText: d.incoming, mode: 'secretary', remember: false });
  const guarded = guardOutgoing(raw, { ownerName, lang: d.lang });
  await db.insert(drafts).values({ id: d.id, answer: guarded.text, guard: JSON.stringify(guarded.reasons) })
    .onConflictDoUpdate({ target: drafts.id, set: { answer: guarded.text, guard: JSON.stringify(guarded.reasons) } }).run();
  await refreshCard(d.id);
  return getDraft(d.id);
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

export function draftLangLabel(code) {
  return language(code)?.label ?? code ?? 'unknown';
}
