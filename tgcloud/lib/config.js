// ---------------------------------------------------------------------------
// The only file you need to edit: set OWNER_ID and TIMEZONE.
//
// OWNER_ID: your numeric Telegram user ID.
// Don't know it? Deploy once, send /id to your bot, paste the number, push again.
// While this is 0 the bot is in "setup mode" and only answers /id.
// ---------------------------------------------------------------------------
export const OWNER_ID = 0;

// Ollama hosted API (no ":cloud" suffix for the direct API).
export const OLLAMA_URL = 'https://ollama.com/api/chat';
export const DEFAULT_MODEL = 'gemma4:31b';   // change live with /model <name>

// Your timezone (IANA name, e.g. 'Europe/London', 'America/New_York'). Used to tell the model what time it is.
export const TIMEZONE = 'Asia/Tehran';

// The date/time line in the prompt is rounded down to this many minutes (keeps the prompt cache-friendly).
export const TIME_ROUND_MINUTES = 10;

// How many past messages are sent to the model per conversation.
export const HISTORY_LIMIT = 20;

// Reply delay: after someone's LAST message, wait this many seconds before answering,
// so several short messages get one combined reply. Counted per person.
// Change live with /delay <seconds> (0 = answer immediately).
export const DEFAULT_REPLY_DELAY = 50;
export const MAX_REPLY_DELAY = 300;

// Telegram shows "typing..." for about 5 seconds per request, so it is repeated this
// often (milliseconds) while the model is thinking.
export const TYPING_REFRESH_MS = 4000;

// Longest custom system prompt accepted by /prompt, in characters.
// (One Telegram message holds only 4096, so longer prompts are sent as a .txt file.)
export const MAX_PROMPT_CHARS = 10000;
export const MAX_PROMPT_FILE_BYTES = 100000;

// Defaults for settings you can change from chat.
export const DEFAULT_PAUSE_HOURS = 4;        // stay quiet in a chat after you replied manually
