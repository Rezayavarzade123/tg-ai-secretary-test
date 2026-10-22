import { api, db } from 'sdk';
import { eq, asc } from 'sdk/db';
import { notes } from '../schema.js';
import { DEFAULT_MODEL, LOCAL_LLM_URL, DEFAULT_PAUSE_HOURS, DEFAULT_REPLY_DELAY, DEFAULT_SECRETARY_MODE, DEFAULT_LANG, MAX_REPLY_DELAY, MAX_PROMPT_CHARS, MAX_PROMPT_FILE_BYTES } from '../lib/config.js';
import { canSleep, sleep } from '../lib/wait.js';
import { parseCommand, displayName, errMsg, decodeUtf8 } from '../lib/text.js';
import { say, withTyping } from '../lib/telegram.js';
import { getSetting, setSetting, delSetting } from '../lib/settings.js';
import { respond, resetHistory, defaultPrompt } from '../lib/brain.js';
import { health } from '../lib/llm.js';
import { countPendingDrafts } from '../lib/drafts.js';
import { setMuted } from '../lib/secretary.js';
import { isOwner, ownerId } from '../lib/owner.js';
import { LANGUAGES, isLanguage, language, languagePromptName } from '../lib/lang.js';

const HELP = `Your assistant is ready. Just write to me normally, or use:

This private chat
/remember <text>  save a private note
/notes  list notes
/forget <id>  delete a note
/reset  clear our conversation memory

Secretary mode (I answer people who message your main account)
/mode draft|auto|off  draft = you approve each reply, auto = send it, off = never
/secretary on|off  master switch for secretary mode
/secretaryinfo <text>  what I may tell people (hours, how to reach you...)
/delay <seconds>  wait after a person's last message before answering (0 = off)
/pause <hours>  stay quiet in a chat after you reply there yourself
/notify on|off  copy every secretary reply to me
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
  if (message.chat.type !== 'private') return;

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

    case 'claim': {
      await say(chatId, `You are already the owner (${await ownerId()}). Nothing to claim.`);
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
      const v = arg.toLowerCase();
      if (!['draft', 'auto', 'off'].includes(v)) {
        await say(chatId,
          `Secretary replies are currently: ${cur.toUpperCase()}\n\n` +
          `/mode draft  show me each reply before it is sent (recommended with a small local model)\n` +
          `/mode auto   send it after the safety checks\n` +
          `/mode off    never answer on my account`);
        return;
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
        `Drafts waiting for you: ${drafts}\n` +
        `Reply delay: ${await getSetting('delay_seconds', String(DEFAULT_REPLY_DELAY))} s${canSleep ? '' : ' (timers unavailable, ignored)'}\n` +
        `Pause after your manual reply: ${await getSetting('pause_hours', String(DEFAULT_PAUSE_HOURS))} h\n` +
        `Copy secretary replies to me: ${(await getSetting('notify', 'on')).toUpperCase()}`);
      return;
    }

    default:
      await say(chatId, `Unknown command /${cmd}.\n\n` + HELP);
  }
}
