import { api, db } from 'sdk';
import { eq, asc } from 'sdk/db';
import { notes } from '../schema.js';
import { DEFAULT_MODEL, LOCAL_LLM_URL, TIMEZONE, DEFAULT_PAUSE_HOURS, DEFAULT_REPLY_DELAY, DEFAULT_SECRETARY_MODE, DEFAULT_LANG, MAX_REPLY_DELAY, MAX_PROMPT_CHARS, MAX_PROMPT_FILE_BYTES } from '../lib/config.js';
import { canSleep, sleep } from '../lib/wait.js';
import { parseCommand, displayName, errMsg, decodeUtf8 } from '../lib/text.js';
import { say, withTyping } from '../lib/telegram.js';
import { getSetting, setSetting, delSetting } from '../lib/settings.js';
import { respond, resetHistory, defaultPrompt } from '../lib/brain.js';
import { health } from '../lib/llm.js';
import { countPendingDrafts, listDrafts, notifyOwner } from '../lib/drafts.js';
import { parseWindow, describeWindow } from '../lib/hours.js';
import { listContacts, getContact, updateContact, NOTES_LIMIT } from '../lib/contacts.js';
import { runProbe, saveProbe, formatProbe, probeVerdict, lastProbe } from '../lib/probe.js';
import { metricsSummary } from '../lib/metrics.js';
import { listFacts, deleteFact, factsEnabled } from '../lib/memory.js';
import { updater as updaterImpl } from '../lib/update-bridge.js';
import { setMuted } from '../lib/secretary.js';
import { isOwner, ownerId } from '../lib/owner.js';
import { LANGUAGES, isLanguage, language, languagePromptName } from '../lib/lang.js';
import { isGroupChat, botIdentity, addressesBot, stripAddress, historyScope, groupMode, threadExtra } from '../lib/groups.js';

const HELP = `Your assistant is ready. Just write to me normally, or use:

This private chat
/remember <text>  save a private note
/notes  list notes
/forget <id>  delete a note
/reset  clear our conversation memory

Secretary mode (I answer people who message your main account)
/mode draft|auto|off  draft = you approve each reply, auto = send it, off = never
/secretary on|off  master switch for secretary mode
/drafts  re-send the cards for my pending drafts
/hours [HH-HH|off]  quiet hours: draft instead of replying (e.g. /hours 22-08)

People (context makes a small model much better)
/contacts  list the people who wrote to me
/contact <chat_id> note <text>  what I should know about them
/contact <chat_id> lang <code|auto>  always answer them in this language
/block <chat_id>, /unblock <chat_id>  ignore this person completely
/whatlearned <chat_id>  what I picked up from them, with ids
/forgetfact <id>  delete one learned fact
/learn on|off  learn facts from conversations at all

Updates
/update  is there a new version on GitHub?
/update apply  install it and restart
/update rollback  go back to the version that ran before

Safety
/probe  test the model against the questions it should fail safely (needed for auto)
/secretaryinfo <text>  what I may tell people (hours, how to reach you...)
/delay <seconds>  wait after a person's last message before answering (0 = off)
/pause <hours>  stay quiet in a chat after you reply there yourself
/notify on|off  copy every secretary reply to me
/groups on|off  answer in group chats when someone mentions me (bot mode only)
/inline on|off  answer when you type @me in any chat, including groups
/mute <chat_id>, /unmute <chat_id>  per-chat switch

System prompts
/prompt bot|secretary [show|default|reset|append <text>|<text>]
  "bot" = how I talk with you here, "secretary" = how I answer people on your account.
  Long prompts: send a .txt file with the caption /prompt secretary

Language
/lang  show the reply language
/lang <code>  e.g. /lang en, /lang fa  (I reply in this language)
/lang auto on|off  follow whoever writes (on) or always use the language above (off)

Setup
/panel  how to open the control panel (model, secrets, prompts, drafts)
/model [name]  show or change the model
/waittest [seconds]  check that long waits work on this platform
/status  show current settings
/id  show your Telegram ID`;

export default async function (message) {
  // Private chats are the main conversation. Groups are handled separately and
  // narrowly (see handleGroup); channels and everything else are ignored.
  const chatType = message.chat?.type;
  if (chatType !== 'private' && !isGroupChat(chatType)) return;
  if (isGroupChat(chatType)) return handleGroup(message);

  const chatId = message.chat.id;
  const fromId = message.from?.id;
  const text = message.text ?? '';
  // A command may also be the caption of an uploaded file (used by /prompt <mode> + .txt file).
  const parsed = parseCommand(text || message.caption || '');

  // /id works for anyone: it's how you find your numeric Telegram ID.
  if (parsed?.cmd === 'id') {
    await say(chatId, `Your Telegram user ID is ${fromId}`);
    return;
  }

  // Setup mode: no owner configured yet.
  if ((await ownerId()) === 0) {
    if (parsed?.cmd === 'claim') {
      await setSetting('owner_id', String(fromId));
      await setSetting('owner_name', displayName(message.from));
      await say(chatId,
        `✅ You are now the owner (${fromId}).\n` +
        `Everything else is configured in the control panel — send /panel for the address.\n` +
        `Write to me normally to chat; open Settings > Account > Chat Automation and add me there to enable secretary mode.`);
      return;
    }
    await say(chatId,
      `Setup mode. Your Telegram user ID is ${fromId}.\n` +
      `Send /claim to make yourself the owner.\n` +
      `(On a serverless deployment you can also put this number in tgcloud/lib/config.js as OWNER_ID and push.)`);
    return;
  }

  // Everybody else is ignored silently (no free model usage for strangers).
  if (!(await isOwner(fromId))) return;

  // Remember your name for the system prompts.
  const name = displayName(message.from);
  if ((await getSetting('owner_name')) !== name) await setSetting('owner_name', name);

  if (parsed) {
    await runCommand(chatId, message, parsed);
    return;
  }

  if (!text) {
    await say(chatId, 'I can only read text for now. Send me a text message.');
    return;
  }

  try {
    const answer = await withTyping(chatId, null,
      () => respond({ scope: 'bot', userText: text, mode: 'bot' }));
    await say(chatId, answer);
  } catch (e) {
    console.error(e);
    await say(chatId, '⚠️ ' + errMsg(e));
  }
}

// --- group chats -------------------------------------------------------------
//
// The bot is a member of a group as itself, so there is no impersonation risk —
// but it must not answer everything. It replies only when addressed (mention,
// reply to one of its messages, /command@botname), only when the owner has left
// group_mode on, and with its own memory per group. Commands are refused here:
// a group member must not be able to change the owner's settings, and /setkey
// would leak a secret to the room.
async function handleGroup(message) {
  const chatId = message.chat.id;
  if ((await groupMode()) === 'off') return;

  const me = await botIdentity();
  if (!addressesBot(message, me)) return;

  const raw = message.text ?? message.caption ?? '';
  const parsed = parseCommand(raw);
  const extra = threadExtra(message);

  if (parsed) {
    if (parsed.cmd === 'id') {
      await say(chatId, `This group's id is ${chatId}. Your user id is ${message.from?.id}.`, extra);
      return;
    }
    if (['start', 'help'].includes(parsed.cmd)) {
      await say(chatId, 'I answer here when you mention me. Everything else is set up in a private chat with me.', extra);
      return;
    }
    await say(chatId, `/${parsed.cmd} only works in a private chat with me — settings are not changed from a group.`, extra);
    return;
  }

  const text = stripAddress(raw, me);
  if (!text) {
    await say(chatId, `Mention me with a question, e.g. @${me.username || 'me'} what is the plan for Friday?`, extra);
    return;
  }

  try {
    const answer = await withTyping(chatId, null,
      () => respond({ scope: historyScope(message.chat), userText: text, mode: 'bot' }));
    await say(chatId, answer, extra);
  } catch (e) {
    console.error(e);
    await say(chatId, '⚠️ ' + errMsg(e), extra);
  }
}

async function runCommand(chatId, message, { cmd, arg }) {
  switch (cmd) {
    case 'start':
    case 'help':
      await say(chatId, HELP);
      return;

    case 'setkey': {
      // Only used when the brain is the hosted Ollama API. A local model needs no key.
      if (!arg) { await say(chatId, 'Usage: /setkey <your Ollama API key> (only needed for the cloud brain)'); return; }
      await setSetting('ollama_key', arg);
      try {
        await api.deleteMessage({ chat_id: chatId, message_id: message.message_id });
      } catch (e) { /* best effort */ }
      await say(chatId, '🔑 Key saved, and I deleted your message so it is not left in the chat. Say hi to test it.');
      return;
    }

    case 'model': {
      if (!arg) {
        await say(chatId, `Current model: ${await getSetting('model', DEFAULT_MODEL)}\nChange it with /model <name>, e.g. /model gemma4:31b`);
        return;
      }
      await setSetting('model', arg);
      await say(chatId, `Model set to ${arg}.`);
      return;
    }

    case 'inline': {
      const cur = await getSetting('inline_mode', 'owner');
      const handle = (await botIdentity()).username || 'me';
      if (!arg) {
        await say(chatId,
          `Inline mode: ${cur === 'off' ? 'OFF' : 'ON (you only)'}\n\n` +
          `When it is on, type @${handle} followed by a question in any chat — ` +
          'a group I am not in, a channel, a chat with someone else — and my answer appears in the result list. ' +
          'Nothing is sent until you pick it.\n\n' +
          'It is limited to you because my prompt contains your private notes.\n\n' +
          '/inline on    turn it on\n/inline off   turn it off');
        return;
      }
      const v = arg.toLowerCase();
      if (!['on', 'off'].includes(v)) { await say(chatId, 'Usage: /inline on|off'); return; }
      await setSetting('inline_mode', v === 'on' ? 'owner' : 'off');
      await say(chatId, v === 'on'
        ? `Inline mode on: type @${handle} and a question in any chat.`
        : 'Inline mode off: typing my @name will show no results.');
      return;
    }

    case 'groups': {
      const cur = await groupMode();
      if (!arg) {
        await say(chatId,
          `Group chats: ${cur.toUpperCase()}\n\n` +
          (cur === 'on'
            ? 'In a group I answer only when someone mentions me or replies to me. I never change settings there.\n\n'
            : 'I stay silent in groups, even when mentioned.\n\n') +
          `/groups on   answer when mentioned\n/groups off  never answer in groups\n\n` +
          'Secretary mode is private-chat only — Telegram does not deliver group messages to it.');
        return;
      }
      const v = arg.toLowerCase();
      if (!['on', 'off'].includes(v)) { await say(chatId, 'Usage: /groups on|off'); return; }
      await setSetting('group_mode', v);
      await say(chatId, v === 'on'
        ? 'In groups I will answer when mentioned, and only then.'
        : 'I will stay silent in groups.');
      return;
    }

    case 'claim': {
      await say(chatId, `You are already the owner (${await ownerId()}). Nothing to claim.`);
      return;
    }

    case 'hours': {
      const start = await getSetting('quiet_start', '');
      const end = await getSetting('quiet_end', '');
      const tz = await getSetting('timezone', TIMEZONE);
      if (!arg) {
        await say(chatId,
          `Quiet hours: ${describeWindow(start, end)} (${tz})\n` +
          `During quiet hours I never send an automatic reply — I prepare the draft and you find it later.\n\n` +
          `/hours 22-08  set a window (your timezone)\n/hours off    turn it off`);
        return;
      }
      if (/^(off|no|0)$/i.test(arg)) {
        await delSetting('quiet_start');
        await delSetting('quiet_end');
        await say(chatId, 'Quiet hours off: auto mode can reply at any hour.');
        return;
      }
      const m = /^(\d{1,2})\s*(?:-|–|to|until)\s*(\d{1,2})$/.exec(arg);
      if (!m || !parseWindow(m[1], m[2])) {
        await say(chatId, 'Usage: /hours 22-08  (two hours, 0–23, and they must differ)');
        return;
      }
      await setSetting('quiet_start', m[1]);
      await setSetting('quiet_end', m[2]);
      await say(chatId, `Quiet hours set to ${describeWindow(m[1], m[2])} (${tz}). In that window a reply becomes a draft.`);
      return;
    }

    case 'contacts': {
      const rows = await listContacts(12);
      if (!rows.length) {
        await say(chatId, 'Nobody has written to your account yet, or secretary mode has never been used.');
        return;
      }
      await say(chatId, rows.map((c) => {
        const bits = [];
        if (c.lang) bits.push(`lang ${c.lang}`);
        if (c.blocked) bits.push('BLOCKED');
        else if (c.muted) bits.push('muted');
        const note = c.notes ? `\n   ${c.notes.slice(0, 80)}` : '';
        return `${c.blocked ? '⛔' : '•'} ${c.name || 'Unknown'} — ${c.chatId}${bits.length ? ` [${bits.join(', ')}]` : ''}${note}`;
      }).join('\n') + '\n\n/contact <chat_id> note <text> · /block <chat_id>');
      return;
    }

    case 'contact': {
      const m = /^(\d+)\s*(.*)$/s.exec(arg);
      if (!m) {
        await say(chatId, 'Usage:\n/contact <chat_id>  show\n/contact <chat_id> note <text>  set context (max ' + NOTES_LIMIT + ' chars)\n/contact <chat_id> note reset\n/contact <chat_id> lang <code|auto>');
        return;
      }
      const id = Number(m[1]);
      const rest = (m[2] || '').trim();
      const c = await getContact(id);
      if (!rest) {
        if (!c) { await say(chatId, `I have no record of chat ${id}.`); return; }
        await say(chatId,
          `Chat ${id} — ${c.name || 'Unknown'}\n` +
          `Language: ${c.lang || 'follow the sender'}\n` +
          `Blocked: ${c.blocked ? 'yes' : 'no'}\n` +
          `Context: ${c.notes || '(none)'}`);
        return;
      }
      const nm = /^notes?\s+(.*)$/is.exec(rest);
      if (nm) {
        const text = nm[1].trim();
        if (/^reset$/i.test(text)) {
          await updateContact(id, { notes: '' });
          await say(chatId, `Context for chat ${id} cleared.`);
          return;
        }
        await updateContact(id, { notes: text });
        await say(chatId, `Saved for chat ${id}. I will use this when replying to them — it is the only thing I know about them.`);
        return;
      }
      const lm = /^lang\s+(\S+)$/i.exec(rest);
      if (lm) {
        const v = lm[1].toLowerCase();
        if (v === 'auto' || v === 'reset') {
          await updateContact(id, { lang: '' });
          await say(chatId, `Chat ${id} now follows the usual language rules.`);
          return;
        }
        if (!isLanguage(v)) { await say(chatId, `Unknown language "${v}". Use one of: ${LANGUAGES.map((l) => l.code).join(', ')}`); return; }
        await updateContact(id, { lang: v });
        await say(chatId, `Chat ${id} will always be answered in ${languagePromptName(v)}.`);
        return;
      }
      await say(chatId, 'Usage: /contact <chat_id> note <text>  or  /contact <chat_id> lang <code|auto>');
      return;
    }

    case 'update': {
      // Updating needs git, a checkout and the power to restart this process, so it
      // belongs to the local runtime and is registered there (lib/update-bridge.js).
      // On Telegram Serverless there is nothing to register and nothing to update.
      const impl = updaterImpl();
      if (!impl) {
        await say(chatId, 'Updating from GitHub only works on the local runtime. A serverless deployment is updated with npx tgcloud push.');
        return;
      }
      const action = (arg || '').toLowerCase();

      if (!action) {
        const state = await impl.check();
        const auto = (await getSetting('update_check', 'on')) !== 'off';
        const install = await getSetting('update_mode', 'notify');
        const lines = [
          impl.describe(state),
          state.version ? `Version ${state.version} (${state.branch} @ ${String(state.shortHead || state.head || '').slice(0, 7)})` : '',
          auto ? 'Checks: automatic (every 6 hours)' : 'Checks: off',
          install === 'apply' ? 'Installs: automatically (the bot restarts when it does)' : 'Installs: only when you ask',
          '',
          'Install: /update apply\nGo back: /update rollback',
        ].filter((l) => l !== '');
        await say(chatId, lines.join('\n'));
        return;
      }

      if (action === 'apply') {
        try {
          const result = await impl.apply();
          const list = (result.commits || []).slice(0, 5).map((c) => `• ${c.subject}`).join('\n');
          await say(chatId, `${result.message}${list ? `\n\n${list}` : ''}${result.updated ? '\n\nRestarting — I will be back in a few seconds.' : ''}`);
          if (result.updated) setTimeout(() => impl.restart('update from Telegram'), 3000);
        } catch (e) {
          await say(chatId, `Not updated: ${e.message}`);
        }
        return;
      }

      if (action === 'rollback') {
        try {
          const result = await impl.rollback();
          await say(chatId, `${result.message}\nRestarting — I will be back in a few seconds.`);
          setTimeout(() => impl.restart('rollback from Telegram'), 3000);
        } catch (e) {
          await say(chatId, `Could not roll back: ${e.message}`);
        }
        return;
      }

      await say(chatId, 'Usage: /update, /update apply, /update rollback');
      return;
    }

    case 'whatlearned': {
      const id = Number(arg);
      if (!Number.isInteger(id) || id === 0) { await say(chatId, 'Usage: /whatlearned <chat_id> (see /contacts)'); return; }
      const facts = await listFacts(id);
      if (!facts.length) {
        await say(chatId, `Nothing learned about chat ${id} yet. I only write down what someone says about themselves, after a few messages.`);
        return;
      }
      await say(chatId,
        `What I learned about chat ${id} (their words, not instructions):\n` +
        facts.map((f) => `#${f.id} ${f.text}${f.pinned ? ' 📌' : ''}`).join('\n') +
        `\n\nDelete one with /forgetfact <id>, or in the control panel.`);
      return;
    }

    case 'forgetfact': {
      const id = Number(arg);
      if (!Number.isInteger(id) || id === 0) { await say(chatId, 'Usage: /forgetfact <id> (see /whatlearned)'); return; }
      const ok = await deleteFact(id);
      await say(chatId, ok ? `Forgotten (#${id}).` : `There is no fact #${id}.`);
      return;
    }

    case 'learn': {
      const cur = await factsEnabled();
      if (!arg) {
        await say(chatId,
          `Learning from conversations: ${cur ? 'ON' : 'OFF'}\n\n` +
          'After a few messages with someone I write down what they say about themselves — their job, ' +
          'family, schedule, how they prefer to be contacted — and use it next time.\n' +
          'Never instructions, never codes, passwords or card numbers. You can see and delete ' +
          'everything with /whatlearned <chat_id> or in the People tab.\n\n' +
          '/learn on|off');
        return;
      }
      const v = arg.toLowerCase();
      if (!['on', 'off'].includes(v)) { await say(chatId, 'Usage: /learn on|off'); return; }
      await setSetting('facts_learn', v);
      await say(chatId, v === 'on'
        ? 'I will learn facts from conversations again.'
        : 'I will stop learning new facts. What I already know stays until you delete it.');
      return;
    }

    case 'block':
    case 'unblock': {
      const id = Number(arg);
      if (!Number.isInteger(id)) { await say(chatId, `Usage: /${cmd} <chat_id>`); return; }
      await updateContact(id, { blocked: cmd === 'block' });
      await say(chatId, cmd === 'block'
        ? `⛔ Chat ${id} is blocked: I will not read, draft or answer anything there.`
        : `Chat ${id} unblocked.`);
      return;
    }

    case 'drafts': {
      const pending = await listDrafts({ status: 'pending', limit: 5 });
      const total = await countPendingDrafts();
      if (!pending.length) { await say(chatId, 'No drafts waiting. Everything is answered or ignored.'); return; }
      await say(chatId, `${total} draft${total === 1 ? '' : 's'} waiting. Re-sending ${pending.length === total ? 'them all' : `the newest ${pending.length}`} below.`);
      for (const d of pending) await notifyOwner(d);
      return;
    }

    case 'probe': {
      const last = await lastProbe();
      if (arg.toLowerCase() === 'show' && last) { await say(chatId, formatProbe(last)); return; }
      const tzNote = 'This runs the model against 8 awkward messages; on a slow machine it takes minutes.';
      await say(chatId, `🧪 Probing… ${tzNote}`);
      let progressMsgId = null;
      try {
        const sent = await api.sendMessage({ chat_id: chatId, text: '0/8' });
        progressMsgId = sent?.message_id;
      } catch { /* progress is a nicety */ }

      const lang = await getSetting('lang', DEFAULT_LANG);
      const summary = await runProbe({
        ownerName: await getSetting('owner_name', 'the owner'),
        lang,
        onProgress: async (done, total) => {
          if (!progressMsgId || done % 2) return;
          try { await api.editMessageText({ chat_id: chatId, message_id: progressMsgId, text: `${done}/${total}` }); } catch { /* ignore */ }
        },
      });
      const { modelSettings } = await import('../lib/brain.js');
      const { model } = await modelSettings();
      await saveProbe(summary, model);
      if (progressMsgId) {
        try { await api.deleteMessage({ chat_id: chatId, message_id: progressMsgId }); } catch { /* ignore */ }
      }
      await say(chatId, formatProbe(summary));
      return;
    }

    case 'lang': {
      const cur = await getSetting('lang', DEFAULT_LANG);
      const auto = (await getSetting('lang_auto', 'on')) !== 'off';
      const list = LANGUAGES.map((l) => `${l.code} — ${l.native}`).join('\n');
      if (!arg) {
        await say(chatId,
          `Reply language: ${languagePromptName(cur)} (${cur})\n` +
          `Follow the person's language: ${auto ? 'ON' : 'OFF'}\n\n` +
          `Commands:\n/lang <code>  always use this language\n/lang auto on|off  follow whoever writes\n\n` +
          `Available codes:\n${list}`);
        return;
      }
      const parts = arg.toLowerCase().split(/\s+/);
      if (parts[0] === 'auto') {
        const v = parts[1];
        if (v !== 'on' && v !== 'off') { await say(chatId, 'Usage: /lang auto on|off'); return; }
        await setSetting('lang_auto', v);
        await say(chatId, v === 'on'
          ? 'I will reply in whatever language the person writes in.'
          : `I will always reply in ${languagePromptName(await getSetting('lang', DEFAULT_LANG))}.`);
        return;
      }
      if (!isLanguage(parts[0])) {
        await say(chatId, `Unknown language "${parts[0]}". Use one of: ${LANGUAGES.map((l) => l.code).join(', ')}`);
        return;
      }
      await setSetting('lang', parts[0]);
      const lang = language(parts[0]);
      await say(chatId, `✅ Reply language set to ${lang.label} (${lang.native}).\nUse /lang auto on if I should follow each person instead.`);
      return;
    }

    case 'mode': {
      const cur = await getSetting('secretary_mode', DEFAULT_SECRETARY_MODE);
      // "/mode auto force": the first word is the mode, the rest are flags.
      const [v, ...flags] = arg.toLowerCase().split(/\s+/);
      if (!['draft', 'auto', 'off'].includes(v)) {
        await say(chatId,
          `Secretary replies are currently: ${cur.toUpperCase()}\n\n` +
          `/mode draft  show me each reply before it is sent (recommended with a small local model)\n` +
          `/mode auto   send it after the safety checks\n` +
          `/mode off    never answer on my account`);
        return;
      }
      if (v === 'auto') {
        // The gate: auto mode must be earned by a recent, passing probe.
        const force = flags.includes('force');
        const verdict = await probeVerdict();
        if (!verdict.ok && !force) {
          await say(chatId,
            `🔒 Not switching to auto yet: ${verdict.reason}.\n\n` +
            `Run /probe first — it checks the replies that would actually be sent, including the safety net. ` +
            `Auto needs ${verdict.min}/8.\n` +
            `Drafts work exactly the same without it.\n\n` +
            `(If you know what you are doing: /mode auto force)`);
          return;
        }
        await setSetting('probe_forced_at', verdict.ok ? '' : String(Math.floor(Date.now() / 1000)));
      }
      await setSetting('secretary_mode', v);
      await setSetting('secretary', v === 'off' ? 'off' : 'on');
      await say(chatId, v === 'draft'
        ? '✅ Draft mode: I will send each suggested reply to you for approval before it reaches anyone.'
        : v === 'auto'
          ? '✅ Auto mode: I answer incoming messages myself, after checking the reply against the safety rules.'
          : '✅ I will not answer anyone on your main account.');
      return;
    }

    case 'panel': {
      const url = await getSetting('panel_url', '');
      await say(chatId,
        (url ? `🖥 Control panel: ${url}\n\n` : '🖥 The control panel runs next to the bot (bot/panel).\n\n') +
        `It is where you set the model server, the language, the prompts, secretary mode and the drafts.\n` +
        `It is meant for your own network only — never expose it to the internet.`);
      return;
    }

    case 'prompt': {
      const m = /^(bot|secretary)(?:\s+([\s\S]*))?$/i.exec(arg);
      if (!m) {
        await say(chatId,
          'Usage:\n' +
          '/prompt bot  or  /prompt secretary  : show the prompt in use\n' +
          '/prompt secretary default  : show the built-in default (copy and edit it)\n' +
          '/prompt secretary reset  : go back to the default\n' +
          '/prompt secretary <your full prompt>  : replace it (use {owner} for your name)\n' +
          '/prompt secretary append <more text>  : add to your custom prompt\n' +
          `Longer than one message (4096 characters)? Send a .txt or .md file with the caption /prompt secretary (up to ${MAX_PROMPT_CHARS} characters).\n\n` +
          '"bot" = how I talk with you in this chat. "secretary" = how I answer people who write to your main account.\n' +
          'Always added by the code, around your text: date/time first; your notes last (bot); the anti-hijacking line before and your /secretaryinfo after (secretary).');
        return;
      }
      const mode = m[1].toLowerCase();          // "bot" | "secretary"
      const key = `prompt_${mode}`;
      const body = (m[2] || '').trim();
      const ownerName = await getSetting('owner_name', 'the owner');

      // A text file sent with the caption "/prompt secretary" or "/prompt bot":
      // the way to set a prompt longer than one Telegram message.
      if (message.document) {
        const d = message.document;
        const looksText = (d.mime_type || '').startsWith('text/') || /\.(txt|md)$/i.test(d.file_name || '');
        if (!looksText) { await say(chatId, 'Please send a plain text file (.txt or .md).'); return; }
        if ((d.file_size || 0) > MAX_PROMPT_FILE_BYTES) {
          await say(chatId, `That file is too large (limit ${MAX_PROMPT_FILE_BYTES} bytes).`);
          return;
        }
        let fileText;
        try {
          fileText = decodeUtf8(await api.getFileContent(d.file_id)).replace(/^﻿/, '').trim();
        } catch (e) {
          await say(chatId, '⚠️ I could not read that file: ' + errMsg(e));
          return;
        }
        if (!fileText) { await say(chatId, 'The file is empty.'); return; }
        if (fileText.length > MAX_PROMPT_CHARS) {
          await say(chatId, `The file has ${fileText.length} characters; the limit is ${MAX_PROMPT_CHARS}.`);
          return;
        }
        await setSetting(key, fileText);
        await say(chatId, `✅ ${mode} prompt replaced from your file (${fileText.length} characters). It applies from the next message.`);
        return;
      }

      // "append <text>": add to the existing custom prompt (for building one in several messages).
      if (/^append$/i.test(body)) { await say(chatId, `Usage: /prompt ${mode} append <more text>`); return; }
      const ap = /^append\s+([\s\S]+)$/i.exec(body);
      if (ap) {
        const current = await getSetting(key);
        if (!current) {
          await say(chatId, `There is no custom ${mode} prompt yet. Start it with /prompt ${mode} <first part>, then append the rest.`);
          return;
        }
        const joined = current + '\n' + ap[1].trim();
        if (joined.length > MAX_PROMPT_CHARS) {
          await say(chatId, `That would make the prompt ${joined.length} characters; the limit is ${MAX_PROMPT_CHARS}. Nothing was changed.`);
          return;
        }
        await setSetting(key, joined);
        await say(chatId, `✅ Added. The ${mode} prompt is now ${joined.length} characters.`);
        return;
      }

      if (!body || body.toLowerCase() === 'show') {
        const custom = await getSetting(key);
        await say(chatId, `${custom ? 'CUSTOM' : 'DEFAULT'} ${mode} prompt:\n\n${custom ?? defaultPrompt(mode, ownerName)}`);
        return;
      }
      if (body.toLowerCase() === 'default') {
        await say(chatId, `Built-in ${mode} prompt:\n\n${defaultPrompt(mode, ownerName)}`);
        return;
      }
      if (body.toLowerCase() === 'reset') {
        await delSetting(key);
        await say(chatId, `The ${mode} prompt is back to the built-in default.`);
        return;
      }
      if (body.length > MAX_PROMPT_CHARS) {
        await say(chatId, `That prompt is ${body.length} characters; the limit is ${MAX_PROMPT_CHARS}. Shorten it and resend.`);
        return;
      }
      await setSetting(key, body);
      await say(chatId, `✅ ${mode} prompt replaced (${body.length} characters). It applies from the next message. "/prompt ${mode} reset" restores the default.`);
      return;
    }

    case 'remember': {
      if (!arg) { await say(chatId, 'Usage: /remember <something to keep>'); return; }
      const [row] = await db.insert(notes).values({ text: arg }).returning().run();
      await say(chatId, `Saved as note #${row.id}.`);
      return;
    }

    case 'notes': {
      const rows = await db.select().from(notes).orderBy(asc(notes.id)).all();
      await say(chatId, rows.length ? rows.map((n) => `#${n.id}  ${n.text}`).join('\n') : 'No notes yet. Use /remember <text>.');
      return;
    }

    case 'forget': {
      const id = Number(arg);
      if (!Number.isInteger(id)) { await say(chatId, 'Usage: /forget <note id>'); return; }
      await db.delete(notes).where(eq(notes.id, id)).run();
      await say(chatId, `Note #${id} deleted (if it existed).`);
      return;
    }

    case 'reset':
      await resetHistory('bot');
      await say(chatId, 'Conversation memory cleared. Your notes are untouched.');
      return;

    case 'secretary': {
      const v = arg.toLowerCase();
      if (v !== 'on' && v !== 'off') {
        await say(chatId, `Secretary mode is ${(await getSetting('secretary', 'on')).toUpperCase()}. Use /secretary on  or  /secretary off.`);
        return;
      }
      await setSetting('secretary', v);
      await say(chatId, v === 'on'
        ? 'Secretary mode is now ON: I answer people who message your main account.'
        : 'Secretary mode is now OFF: I will not answer anyone on your main account.');
      return;
    }

    case 'secretaryinfo': {
      if (!arg) { await say(chatId, 'Information the secretary may share:\n' + (await getSetting('secretary_info', '(nothing yet)'))); return; }
      if (arg.toLowerCase() === 'reset') { await delSetting('secretary_info'); await say(chatId, 'Cleared.'); return; }
      await setSetting('secretary_info', arg);
      await say(chatId, 'Saved. The secretary may share this with people who message your main account.');
      return;
    }

    case 'delay': {
      if (!arg) {
        const cur = await getSetting('delay_seconds', String(DEFAULT_REPLY_DELAY));
        await say(chatId, `Reply delay: ${cur} s. Change it with /delay <seconds> (0 = answer immediately, max ${MAX_REPLY_DELAY}).`);
        return;
      }
      const s = Number(arg);
      if (!Number.isFinite(s) || s < 0 || s > MAX_REPLY_DELAY) {
        await say(chatId, `Usage: /delay <seconds>, between 0 and ${MAX_REPLY_DELAY}.`);
        return;
      }
      await setSetting('delay_seconds', String(Math.round(s)));
      await say(chatId, s === 0
        ? 'Reply delay off: the secretary answers every message immediately.'
        : `Reply delay set to ${Math.round(s)} s. The secretary waits that long after each person's last message, then answers all their fragments at once. Every chat has its own timer.`);
      return;
    }

    case 'waittest': {
      if (!canSleep) { await say(chatId, '❌ This runtime has no timers (setTimeout), so a reply delay is not possible. Use /delay 0.'); return; }
      const s = Math.min(Math.max(Math.round(Number(arg) || 30), 1), MAX_REPLY_DELAY);
      await say(chatId, `⏳ Waiting ${s} s. Send /status now: if it answers right away, a waiting reply does not block other chats.`);
      const t0 = Date.now();
      await sleep(s * 1000);
      await say(chatId, `✅ Survived a ${s} s wait (measured ${Math.round((Date.now() - t0) / 1000)} s). Delays up to this length work.`);
      return;
    }

    case 'pause': {
      const h = Number(arg);
      if (!Number.isFinite(h) || h < 0) { await say(chatId, 'Usage: /pause <hours>, e.g. /pause 4 (0 = never pause)'); return; }
      await setSetting('pause_hours', String(h));
      await say(chatId, `After you reply manually in a chat, the secretary stays quiet there for ${h} hour(s).`);
      return;
    }

    case 'notify': {
      const v = arg.toLowerCase();
      if (v !== 'on' && v !== 'off') { await say(chatId, 'Usage: /notify on  or  /notify off'); return; }
      await setSetting('notify', v);
      await say(chatId, `Copies of secretary replies are now ${v.toUpperCase()}.`);
      return;
    }

    case 'mute':
    case 'unmute': {
      const id = Number(arg);
      if (!Number.isInteger(id)) { await say(chatId, `Usage: /${cmd} <chat_id>  (the id is shown in my notifications)`); return; }
      await setMuted(id, cmd === 'mute');
      await say(chatId, `Chat ${id} ${cmd === 'mute' ? 'muted' : 'unmuted'}.`);
      return;
    }

    case 'status': {
      const provider = await getSetting('llm_provider', 'local');
      const baseUrl = await getSetting('llm_base_url', LOCAL_LLM_URL);
      const cloudKey = (await getSetting('llm_api_key')) ?? (await getSetting('ollama_key'));
      const key = provider === 'cloud' ? (cloudKey ? 'saved' : 'MISSING (use /setkey)') : 'not needed (local)';
      const conns = JSON.parse(await getSetting('secretary_conns', '[]')).length;
      const mode = await getSetting('secretary_mode', DEFAULT_SECRETARY_MODE);
      const lang = await getSetting('lang', DEFAULT_LANG);
      const auto = (await getSetting('lang_auto', 'on')) !== 'off';
      const drafts = await countPendingDrafts();
      const contacts = (await listContacts(500)).length;
      const blocked = (await listContacts(500)).filter((c) => c.blocked).length;
      const quiet = describeWindow(await getSetting('quiet_start', ''), await getSetting('quiet_end', ''));
      const probe = await probeVerdict();
      let speed = '';
      try {
        const m = await metricsSummary(20);
        if (m.count) {
          speed = m.timedCalls
            ? `Last ${m.count} replies: ${m.avgTotalMs} ms avg, ${m.decodeTps} tok/s out, ${m.prefillTps} tok/s prefill, ~${m.avgPromptTokens} prompt tokens`
            : `Last ${m.count} replies: ${m.avgTotalMs} ms avg (the server reported no timings, so no tok/s)`;
        }
      } catch { /* metrics are optional */ }
      let brain = '';
      try {
        const h = await health({ baseUrl });
        brain = h.ok
          ? `Model server: online (${h.ms} ms)${h.models?.length ? ' — ' + h.models.join(', ') : ''}`
          : `Model server: OFFLINE — ${h.error}`;
      } catch (e) {
        brain = 'Model server: unknown (' + errMsg(e) + ')';
      }
      await say(chatId,
        `Brain: ${provider} at ${provider === 'cloud' ? 'ollama.com' : baseUrl}\n` +
        `Model: ${await getSetting('model', DEFAULT_MODEL)}\n` +
        `${brain}\n` +
        `API key: ${key}\n` +
        `Secretary mode: ${(await getSetting('secretary', 'on')).toUpperCase()} (${mode})\n` +
        `Connected accounts: ${conns}${conns ? '' : '  (connect me in Telegram Settings > Account > Chat Automation)'}\n` +
        `Language: ${languagePromptName(lang)}${auto ? ', following the person' : ', fixed'}\n` +
        `Quiet hours: ${quiet}\n` +
        `Contacts known: ${contacts}${blocked ? ` (${blocked} blocked)` : ''}\n` +
        `Auto mode gate: ${probe.ok ? 'open' : 'locked'} — ${probe.reason}\n` +
        `Drafts waiting for you: ${drafts}\n` +
        `${speed ? speed + '\n' : ''}` +
        `Reply delay: ${await getSetting('delay_seconds', String(DEFAULT_REPLY_DELAY))} s${canSleep ? '' : ' (timers unavailable, ignored)'}\n` +
        `Pause after your manual reply: ${await getSetting('pause_hours', String(DEFAULT_PAUSE_HOURS))} h\n` +
        `Copy secretary replies to me: ${(await getSetting('notify', 'on')).toUpperCase()}`);
      return;
    }

    default:
      await say(chatId, `Unknown command /${cmd}.\n\n` + HELP);
  }
}
