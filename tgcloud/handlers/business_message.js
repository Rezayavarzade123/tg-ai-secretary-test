import { DEFAULT_REPLY_DELAY, DEFAULT_SECRETARY_MODE, DEFAULT_LANG } from '../lib/config.js';
import { displayName, errMsg } from '../lib/text.js';
import { say, withTyping, tellOwner } from '../lib/telegram.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { respond, rememberExchange } from '../lib/brain.js';
import { isSecretaryConnection, noteContact, touchOwnerActive, shouldReply } from '../lib/secretary.js';
import { queueFragment, claimBatch, clearPending } from '../lib/pending.js';
import { canSleep, sleep } from '../lib/wait.js';
import { isOwner, ownerName } from '../lib/owner.js';
import { guardOutgoing, looksUrgent, guardTexts } from '../lib/guard.js';
import { resolveLang } from '../lib/lang.js';
import { saveDraft, notifyOwner } from '../lib/drafts.js';
import { logActivity } from '../lib/activity.js';

// SECRETARY MODE: someone wrote to (or you wrote from) your main account's private chats.
//
// This file keeps the name "business_message" because that is what Telegram's API still
// calls the update, and the file name is how Telegram Serverless routes it. In this
// project the feature is called Secretary mode.
//
// Reply delay ("breathing time"): every fragment is queued, then this invocation
// waits. When the wait is over, only the invocation that holds the person's NEWEST
// fragment answers, with all their fragments merged. Each chat has its own queue,
// so one person's burst never delays or merges with anybody else's.
//
// Three ways to answer (setting `secretary_mode`):
//   auto  - send the model's reply, after the safety net in lib/guard.js
//   draft - send nothing; show the draft to the owner for approval (default)
//   off   - never reply on the owner's account
export default async function (msg) {
  const connId = msg.business_connection_id;
  if (!(await isSecretaryConnection(connId))) return;

  const chatId = msg.chat.id;

  // You wrote this yourself -> don't answer, cancel anything queued, stay quiet a while.
  if (await isOwner(msg.from?.id)) {
    await touchOwnerActive(chatId);
    await clearPending(chatId);
    return;
  }

  if (msg.from?.is_bot) return;                       // never chat with other bots

  const mode = await getSetting('secretary_mode', DEFAULT_SECRETARY_MODE);
  if ((await getSetting('secretary', 'on')) !== 'on' || mode === 'off') return;

  const name = displayName(msg.from);
  await noteContact(chatId, name);
  if (!(await shouldReply(chatId))) return;

  const text = msg.text ?? msg.caption;
  if (!text) {
    await tellOwner(`📎 ${name} sent something that is not text (chat ${chatId}). I did not reply.`);
    return;
  }

  const owner = await ownerName();
  const preferredLang = await getSetting('lang', DEFAULT_LANG);
  const lang = resolveLang(preferredLang, text);
  const langAuto = (await getSetting('lang_auto', 'on')) !== 'off';
  const guardLang = langAuto ? lang : preferredLang;

  try {
    // Emergencies never go through a 1-2B model: the fixed sentence is faster and safer.
    if (looksUrgent(text)) {
      const t = guardTexts(guardLang).urgent(owner);
      await say(chatId, t, { business_connection_id: connId });
      await logActivity('blocked', `Emergency-sounding message from ${name} (chat ${chatId}) answered with the fixed escalation text.`);
      await tellOwner(`🚨 ${name} (chat ${chatId}) wrote something that sounds urgent. I sent the fixed "call emergency services" reply and did not use the model:\n\n${text}`);
      return;
    }

    const myId = await queueFragment({ chatId, connId, name, text });

    const delay = Number(await getSetting('delay_seconds', String(DEFAULT_REPLY_DELAY)));
    if (delay > 0) {
      if (canSleep) {
        await sleep(delay * 1000);
      } else if ((await getSetting('nosleep_warned')) !== '1') {
        await setSetting('nosleep_warned', '1');
        await tellOwner('ℹ️ This runtime has no timers, so the reply delay is ignored and I answer immediately. Set /delay 0 to silence this.');
      }
    }

    // Newest fragment of this chat wins; older fragments' invocations end here.
    const batch = await claimBatch(chatId, myId);
    if (!batch) return;

    // Things may have changed while waiting: you replied yourself, or switched secretary mode off.
    const modeNow = await getSetting('secretary_mode', DEFAULT_SECRETARY_MODE);
    if ((await getSetting('secretary', 'on')) !== 'on' || modeNow === 'off') return;
    if (!(await shouldReply(chatId))) return;

    // The indicator starts only now, after the reply delay, so the person doesn't see
    // "typing..." for the whole wait while the bot is still collecting their fragments.
    const raw = await withTyping(chatId, batch.connId,
      () => respond({ scope: `secretary:${chatId}`, userText: batch.text, mode: 'secretary', remember: false }));
    const guarded = guardOutgoing(raw, { ownerName: owner, lang: guardLang });

    await logActivity('info', `${name} (chat ${chatId}): ${batch.text.slice(0, 180)}`);

    if (modeNow === 'draft') {
      const draft = await saveDraft({
        chatId,
        connId: batch.connId,
        name,
        incoming: batch.text,
        answer: guarded.text,
        reasons: guarded.reasons,
        lang: guardLang,
      });
      await notifyOwner(draft);
      return;
    }

    // modeNow === 'auto'
    await say(chatId, guarded.text, { business_connection_id: batch.connId });
    await rememberExchange(`secretary:${chatId}`, batch.text, guarded.text);

    if ((await getSetting('notify', 'on')) === 'on') {
      const many = batch.count > 1 ? ` (${batch.count} messages merged)` : '';
      const shield = guarded.reasons.length ? `\n\n🛡 Replaced the model's wording: ${guarded.reasons.join(', ')}` : '';
      await tellOwner(`📩 ${name} (chat ${chatId})${many}:\n${batch.text}\n\n🤖 I replied:\n${guarded.text}${shield}`);
    }
  } catch (e) {
    console.error(e);
    await logActivity('error', `Reply to ${name} (chat ${chatId}) failed: ${errMsg(e)}`);
    await tellOwner(`⚠️ I could not reply to ${name} (chat ${chatId}): ${errMsg(e)}\nTheir message: ${text}`);
  }
}
