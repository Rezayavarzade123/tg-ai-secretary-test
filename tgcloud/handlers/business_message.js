import { OWNER_ID, DEFAULT_REPLY_DELAY } from '../lib/config.js';
import { displayName, errMsg } from '../lib/text.js';
import { say, withTyping, tellOwner } from '../lib/telegram.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { respond } from '../lib/brain.js';
import { isSecretaryConnection, noteContact, touchOwnerActive, shouldReply } from '../lib/secretary.js';
import { queueFragment, claimBatch, clearPending } from '../lib/pending.js';
import { canSleep, sleep } from '../lib/wait.js';

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
export default async function (msg) {
  const connId = msg.business_connection_id;
  if (!(await isSecretaryConnection(connId))) return;

  const chatId = msg.chat.id;

  // You wrote this yourself -> don't answer, cancel anything queued, stay quiet a while.
  if (msg.from?.id === OWNER_ID) {
    await touchOwnerActive(chatId);
    await clearPending(chatId);
    return;
  }

  if (msg.from?.is_bot) return;                       // never chat with other bots
  if ((await getSetting('secretary', 'on')) !== 'on') return;

  const name = displayName(msg.from);
  await noteContact(chatId, name);
  if (!(await shouldReply(chatId))) return;

  const text = msg.text ?? msg.caption;
  if (!text) {
    await tellOwner(`📎 ${name} sent something that is not text (chat ${chatId}). I did not reply.`);
    return;
  }

  try {
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
    if ((await getSetting('secretary', 'on')) !== 'on') return;
    if (!(await shouldReply(chatId))) return;

    // The indicator starts only now, after the reply delay, so the person doesn't see
    // "typing..." for the whole wait while the bot is still collecting their fragments.
    const answer = await withTyping(chatId, batch.connId,
      () => respond({ scope: `secretary:${chatId}`, userText: batch.text, mode: 'secretary' }));
    await say(chatId, answer, { business_connection_id: batch.connId });

    if ((await getSetting('notify', 'on')) === 'on') {
      const many = batch.count > 1 ? ` (${batch.count} messages merged)` : '';
      await tellOwner(`📩 ${name} (chat ${chatId})${many}:\n${batch.text}\n\n🤖 I replied:\n${answer}`);
    }
  } catch (e) {
    console.error(e);
    await tellOwner(`⚠️ I could not reply to ${name} (chat ${chatId}): ${errMsg(e)}\nTheir message: ${text}`);
  }
}
