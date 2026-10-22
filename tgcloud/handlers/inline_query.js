import { api } from 'sdk';
import { getSetting } from '../lib/settings.js';
import { isOwner } from '../lib/owner.js';
import { respond } from '../lib/brain.js';
import { LLM_TIMEOUT_MS } from '../lib/config.js';

// Inline mode: @yourbot <question> in ANY chat.
//
// This is how the bot helps in groups without being a member, without privacy
// mode being changed, and without writing anything until the owner presses the
// result. The owner types an @mention in a group, picks the answer from the
// result list, and it is sent as their own message — no bot post, no "sent by a
// bot" label, and nothing happens if they change their mind.
//
// Three rules make it safe to run on a slow CPU:
//
//   1. Owner only. The bot-mode prompt contains the owner's private notes, so an
//      inline answer is private by definition. Everyone else gets no results — not
//      a refusal, not a model call, nothing to leak.
//   2. Typing is not thinking. Telegram sends an inline query for *every*
//      keystroke, and a keystroke is not worth 20 seconds of prefill. Each query
//      is answered instantly with a placeholder; only the last query after a short
//      pause reaches the model, and an identical query within a minute reuses the
//      previous answer.
//   3. No memory. Inline questions are one-shot, so nothing is loaded from or
//      written to the conversation history — the prompt stays small, which is what
//      keeps the answer inside the time Telegram gives an inline query.

const INLINE_DEBOUNCE_MS = Number(process.env.INLINE_DEBOUNCE_MS ?? 700);
const INLINE_TIMEOUT_MS = Math.min(LLM_TIMEOUT_MS, 25000);
const INLINE_REUSE_MS = 60_000;
const MIN_QUERY_CHARS = 3;
const MAX_CONTENT_CHARS = 4000;

// Per user: the query being typed, and the last answer we produced.
const typing = new Map();     // userId -> { id, text, timer }
const answers = new Map();    // userId -> { text, answer, at }

// Test seam: forget everything (and any pending timers).
export function resetInlineState() {
  for (const entry of typing.values()) if (entry.timer) clearTimeout(entry.timer);
  typing.clear();
  answers.clear();
}

export async function inlineMode() {
  return (await getSetting('inline_mode', 'owner')) === 'off' ? 'off' : 'owner';
}

// --- Telegram payloads (pure, so the shapes can be tested) --------------------

export function article(id, title, description, text) {
  return {
    type: 'article',
    id,
    title,
    description,
    input_message_content: { message_text: String(text).slice(0, MAX_CONTENT_CHARS) },
  };
}

export function placeholderResult(query) {
  return [article(
    'thinking',
    'Thinking…',
    query ? `${query.slice(0, 60)} — a small model on a CPU takes a few seconds` : 'a small model on a CPU takes a few seconds',
    '⏳ Still thinking — ask again in a moment.'
  )];
}

export function answerResults(text) {
  return [article('answer', 'Send this', `“${text.slice(0, 80).replace(/\s+/g, ' ')}…”`, text)];
}

export function errorResult(message) {
  return [article('error', 'No answer', message.slice(0, 120), `⚠️ ${message}`)];
}

// --- the handler -------------------------------------------------------------

export default async function handleInlineQuery(query, options = {}) {
  const debounceMs = options.debounceMs ?? INLINE_DEBOUNCE_MS;
  const inlineQueryId = query?.id;
  const fromId = query?.from?.id;
  const text = String(query?.query ?? '').trim();
  if (!inlineQueryId) return;

  if ((await inlineMode()) === 'off') {
    await answer(inlineQueryId, [], { silent: true });
    return;
  }

  // Owner only. A stranger gets an empty list plus a button to private chat: it
  // says nothing about the owner, costs no tokens, and cannot leak the notes.
  if (!(await isOwner(fromId))) {
    await answer(inlineQueryId, [], {
      switch_pm_text: 'This is someone\'s personal assistant',
      switch_pm_parameter: 'inline',
    });
    return;
  }

  // Too short to be a question: do not spend a model call on it.
  if (text.length < MIN_QUERY_CHARS) {
    await answer(inlineQueryId, [], { silent: true });
    return;
  }

  // Answer this keystroke instantly, so the client is never left waiting.
  await answer(inlineQueryId, placeholderResult(text), {});

  const previous = typing.get(fromId);
  if (previous?.timer) clearTimeout(previous.timer);
  const entry = { id: inlineQueryId, text, timer: null };
  typing.set(fromId, entry);

  entry.timer = setTimeout(async () => {
    entry.timer = null;
    // A newer keystroke arrived while we were waiting: it owns the answer.
    if (typing.get(fromId)?.id !== inlineQueryId) return;

    const cached = answers.get(fromId);
    if (cached && cached.text === text && Date.now() - cached.at < INLINE_REUSE_MS) {
      await answer(inlineQueryId, answerResults(cached.answer), {});
      return;
    }

    try {
      const reply = await respond({
        scope: 'inline',
        userText: text,
        mode: 'bot',
        remember: false,       // one-shot: no history read, none written
        timeoutMs: INLINE_TIMEOUT_MS,
      });
      answers.set(fromId, { text, answer: reply, at: Date.now() });
      await answer(inlineQueryId, answerResults(reply), {});
    } catch (e) {
      const why = e?.message ?? String(e);
      await answer(inlineQueryId, errorResult(why), {});
    }
  }, debounceMs);

  if (typeof entry.timer?.unref === 'function') entry.timer.unref();
}

// Answering a query twice is how the placeholder is replaced. Late answers are
// normal (the client may have moved on), and Telegram rejects them with
// QUERY_ID_INVALID — that is not an error worth reporting.
async function answer(inlineQueryId, results, { silent = false, switch_pm_text, switch_pm_parameter } = {}) {
  const params = {
    inline_query_id: inlineQueryId,
    results,
    cache_time: 0,
    is_personal: true,
  };
  if (switch_pm_text) {
    params.switch_pm_text = switch_pm_text;
    params.switch_pm_parameter = switch_pm_parameter || 'inline';
  }
  try {
    await api.answerInlineQuery(params);
  } catch (e) {
    if (silent || /QUERY_ID_INVALID|query is too old/i.test(e?.description ?? e?.message ?? '')) return;
    console.warn('answerInlineQuery failed:', e?.description ?? e?.message ?? e);
  }
}
