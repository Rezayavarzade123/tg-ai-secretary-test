// ---------------------------------------------------------------------------
// Configuration. Everything here can be overridden from the environment, which
// is how the local runner (bot/runner.mjs) and the control panel configure it.
// When this file runs inside Telegram Serverless, environment variables are
// absent and the plain defaults below apply.
// ---------------------------------------------------------------------------
const env = (...names) => {
  for (const n of names) {
    const v = process.env?.[n];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
};

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// Your numeric Telegram user ID.
// The owner is whoever owns the bot: BOT_OWNER_ID in the environment, or the
// value stored by the control panel. While it is 0 the bot is in "setup mode".
// (The panel can set it at runtime, so this is only the startup default.)
export const OWNER_ID = num(env('BOT_OWNER_ID', 'OWNER_ID'), 0);

// --- Brain -------------------------------------------------------------------
// "local"  -> an OpenAI-compatible server on this machine (llama-server / Ollama)
// "cloud"  -> Ollama's hosted API
export const LLM_PROVIDER = env('LLM_PROVIDER') || 'local';

// Base URL of the local model server. llama-server serves /v1/chat/completions.
// For Ollama on the same machine use http://127.0.0.1:11434/v1 instead.
export const LOCAL_LLM_URL = (env('LLM_BASE_URL', 'LOCAL_LLM_URL') || 'http://127.0.0.1:8080').replace(/\/+$/, '');

// Optional key for the local server (llama-server --api-key) or Ollama Cloud.
export const LLM_API_KEY = env('LLM_API_KEY') || '';

// Ollama hosted API (kept as the cloud fallback / option).
export const OLLAMA_URL = 'https://ollama.com/api/chat';
export const DEFAULT_MODEL = env('BOT_MODEL') || 'qwen3-1.7b';   // change live with /model

// How long a single model call may take before it is aborted.
export const LLM_TIMEOUT_MS = num(env('LLM_TIMEOUT_MS'), 90000);

// Your timezone (IANA name, e.g. 'Europe/London', 'America/New_York').
export const TIMEZONE = env('BOT_TIMEZONE', 'TIMEZONE') || 'Asia/Tehran';

// The date/time line in the prompt is rounded down to this many minutes.
export const TIME_ROUND_MINUTES = 10;

// --- Conversation memory ------------------------------------------------------
// Small local models are slow at prefill, so history is deliberately short.
// The private chat with you keeps more context than a stranger's chat.
export const HISTORY_LIMIT = num(env('HISTORY_LIMIT'), 10);
export const HISTORY_LIMIT_SECRETARY = num(env('HISTORY_LIMIT_SECRETARY'), 6);

// Reply length budget, in tokens.
export const NUM_PREDICT_BOT = num(env('NUM_PREDICT_BOT'), 400);
export const NUM_PREDICT_SECRETARY = num(env('NUM_PREDICT_SECRETARY'), 200);

// --- Secretary mode -----------------------------------------------------------
// auto  -> the bot sends its reply straight away (guards still apply)
// draft -> the bot shows YOU a draft in Telegram and you press Send
// off   -> the bot never replies on your account
export const DEFAULT_SECRETARY_MODE = env('SECRETARY_MODE') || 'draft';

// Default reply language ("auto" follows whoever writes).
export const DEFAULT_LANG = env('BOT_LANG') || 'en';
export const DEFAULT_LANG_AUTO = 'on';

// Reply delay: after someone's LAST message, wait this many seconds before answering.
export const DEFAULT_REPLY_DELAY = 50;
export const MAX_REPLY_DELAY = 300;

// Telegram shows "typing..." for about 5 seconds per request.
export const TYPING_REFRESH_MS = 4000;

// Longest custom system prompt accepted by /prompt, in characters.
export const MAX_PROMPT_CHARS = 10000;
export const MAX_PROMPT_FILE_BYTES = 100000;

// Defaults for settings you can change from chat / the panel.
export const DEFAULT_PAUSE_HOURS = 4;        // stay quiet in a chat after you replied manually
