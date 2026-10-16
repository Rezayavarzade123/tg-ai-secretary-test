# Secretary Bot

A serverless Telegram AI assistant and secretary. It runs on **[Telegram Serverless](https://core.telegram.org/bots/serverless)** (no server to rent) and thinks with **[Ollama's hosted API](https://ollama.com)** using your own API key (default model: `gemma4:31b`).

> **Status: experimental.** Telegram Serverless is new, and its docs don't state timeouts or concurrency limits. The unit tests pass, but the reply delay, file-upload prompts and the Chat Automation flow haven't been verified on every account. Step 7 of the setup has you test the delay on your own bot.

## What it does

A Telegram bot is its own account, so it can't read your main account's chats by itself. This project gives you two modes:

| Mode | How it works | Needs |
|---|---|---|
| **Bot mode** | You chat with the bot in your private chat. It remembers the conversation, keeps your private notes and answers questions. | A free Telegram account |
| **Secretary mode** | The bot is connected to your main account. When people message you, the bot answers for you, openly as your AI secretary, and copies you on everything. | **Secretary Mode** enabled for the bot in BotFather (called *Business Mode* in older Telegram docs), then the bot added under **Settings → Account → Chat Automation**. Premium is no longer required ([Bot API changelog, May 8, 2026](https://core.telegram.org/bots/api-changelog)) |

> **A note on names.** In the Telegram app and BotFather the feature is called *Secretary Mode* / *Chat Automation*. Telegram's Bot API still uses its older `business_*` names (`business_message`, `business_connection`, `business_connection_id`), so the two handler files keep those names. Everything you see (commands, bot messages, docs) says *secretary*.

### Features

- **Reply delay ("breathing time"):** waits after a person's *last* message (default 50 s, `/delay <seconds>`) and answers all their fragments at once. The timer is per person, so one chatty contact never delays or merges with anyone else.
- **"typing…" indicator** while the model is working, refreshed every 4 seconds. In secretary chats it starts only after the delay ends.
- **Safeguards:** acts only on connections created by you (`OWNER_ID`), ignores other bots, always says it's an automated assistant and never claims to be you, and makes no promises, appointments or payments.
- **Stays out of your way:** quiet for N hours in a chat after *you* reply manually there (a pending reply is cancelled if you answer during the delay). Mute single chats, or switch secretary mode off with `/secretary off`.
- **Privacy:** it only shares what you wrote with `/secretaryinfo`. Your private notes are never given to outsiders.
- **Editable system prompts at runtime**, up to 10,000 characters, per mode. See [docs/prompts.md](docs/prompts.md).

### Disclaimer

In secretary mode, replies appear in the chat as sent by **your** account, and the other person has no built-in way to tell a bot wrote them. You are responsible for telling people they are talking to an AI (the default prompt does this, so keep that rule) and for complying with the laws and platform rules that apply to you. Messages you receive are sent to Ollama's API and stored in the bot's database. Don't use this for conversations where that isn't acceptable. The software is provided as is, without warranty (see [LICENSE](LICENSE)).

---

## Setup

### 0. Prerequisites

- Node.js 18 or newer
- An Ollama account and API key: <https://ollama.com/settings/keys>
- For secretary mode: a Telegram app that shows **Settings → Account → Chat Automation** (update the app if it doesn't)

### 1. Create the bot and switch Serverless on

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`. Pick a name and username.
2. Open your bot in BotFather, go to **Serverless** and turn it **on**.
3. For secretary mode, also enable **Secretary Mode** in the bot's settings. (Menu wording may differ slightly.)
4. In BotFather → your bot → **Serverless → CLI Access → Access token**, copy the token. It looks like `app<id>:<secret>` and is **not** the bot's API token.

### 2. Get the code and log in

```bash
git clone https://github.com/ygasaino1/tg-ai-secretary.git
cd tg-ai-secretary
npm install
npx tgcloud login        # paste the CLI access token when asked
```

If the CLI complains about the layout, run `npm create @tgcloud/bot .` in this folder. It never overwrites existing files.

### 3. Deploy the first version

```bash
npx tgcloud push         # uploads tgcloud/
npx tgcloud migrate      # creates the tables; answer "yes" to the safe changes
```

Pushing code never touches the database; `migrate` is a separate, confirmed step. Run `migrate` again whenever you change `tgcloud/schema.js`.

### 4. Tell the bot who you are

1. Open your bot in Telegram and send `/id`. It answers with your numeric user ID.
2. Edit `tgcloud/lib/config.js`: set `OWNER_ID` to that number and `TIMEZONE` to yours (an IANA name such as `Europe/London`; it defaults to `Asia/Tehran`):
   ```js
   export const OWNER_ID = 123456789;
   export const TIMEZONE = 'Europe/London';
   ```
3. Deploy again: `npx tgcloud push`

Until `OWNER_ID` is set, the bot is in setup mode and only answers `/id`. After that, everyone else who messages the bot directly is silently ignored, so strangers can't spend your Ollama quota. (People who write to your *main account* are handled by secretary mode instead.)

### 5. Give it the brain

In your chat with the bot:

```
/setkey <your ollama api key>
```

The key is stored in the bot's database (Telegram Serverless doesn't document environment variables or a secrets store), and the bot deletes your message right after saving it. Say "hello" to test. Change the model any time with `/model <name>`.

### 6. Connect your main account (secretary mode)

1. Deploy first, then connect, so the bot sees the connection event.
2. On your main account: **Settings → Account → Chat Automation**. Pick your bot, choose which chats it may handle, and allow it to **reply to messages**.
3. The bot sends you a "🔗 Secretary mode is connected" message.
4. Tell it what it may share:
   ```
   /secretaryinfo I'm travelling until Friday. For urgent things call my office. Replies may take a day.
   ```
5. Ask a friend to message your main account. You'll get a copy of every secretary reply, with the chat ID.

### 7. Check that the reply delay works (2 minutes)

The delay relies on a function waiting a while without being cut off, and on other messages still being processed meanwhile. Test it once:

1. Send the bot `/waittest 60`. It says it's waiting.
2. Immediately send `/status`. If it answers **right away**, a waiting invocation doesn't block others (this is what gives every person their own timer).
3. After 60 s you should get "✅ Survived a 60 s wait".

If it survives, try `/waittest 120` or longer to find the platform's limit, and keep `/delay` below it. If it doesn't survive, or `/status` is held up, use `/delay 0` (answer immediately) and please [open an issue](../../issues) with what you saw.

Tune it with `/delay 50` (default), `/delay 20`, or `/delay 0` to turn it off.

---

## Commands

| Command | What it does |
|---|---|
| *(any text)* | Talk to your assistant (bot mode) |
| `/remember <text>`, `/notes`, `/forget <id>` | Private notes the bot can use in bot mode |
| `/reset` | Clear bot-mode conversation memory (notes stay) |
| `/secretary on\|off` | Switch secretary mode on or off (`/secretary` shows the state) |
| `/secretaryinfo <text>` | What the secretary may tell people (`reset` clears it) |
| `/delay <seconds>` | Wait after a person's last message, then answer once (default 50, 0 = off, max 300) |
| `/pause <hours>` | Quiet period after you reply manually (default 4) |
| `/notify on\|off` | Copy every secretary reply to you |
| `/mute <chat_id>`, `/unmute <chat_id>` | Per-chat switch |
| `/prompt bot\|secretary [show\|default\|reset\|append <text>\|<text>]` | View or replace each mode's system prompt, live. Long prompts: send a `.txt` file with the caption `/prompt secretary`. See [docs/prompts.md](docs/prompts.md) |
| `/waittest [seconds]` | Check that long waits work on this platform |
| `/model [name]`, `/status`, `/setkey`, `/id` | Setup and diagnostics |

---

## Project layout

```
tg-ai-secretary/
├─ tgcloud/                    <- the only part that gets deployed
│  ├─ schema.js                   database tables
│  ├─ handlers/
│  │  ├─ message.js               bot mode: you chatting with the bot + all /commands
│  │  ├─ business_connection.js   secretary mode: you connect/disconnect the bot (Telegram's API name)
│  │  └─ business_message.js      secretary mode: people writing to your main account (Telegram's API name)
│  └─ lib/
│     ├─ config.js                OWNER_ID, timezone, model, limits  <- edit this
│     ├─ brain.js                 prompts + conversation memory + Ollama call
│     ├─ ollama.js                the HTTP call to ollama.com
│     ├─ secretary.js             connection check, per-chat pause/mute
│     ├─ pending.js               per-person queue behind the reply delay
│     ├─ wait.js                  sleep helper (detects missing timers)
│     ├─ telegram.js              send helpers (message splitting, typing indicator)
│     ├─ settings.js              key/value settings in the database
│     └─ text.js                  pure helpers (unit-tested)
├─ tests/                      local unit tests (helpers, reply delay, prompts, typing)
├─ docs/prompts.md             system prompt guide
├─ tgcloud.jsonc               project config
└─ package.json
```

## Developing

```bash
npm test                                  # unit tests (uses a local fake database)
npx tgcloud status                        # what changed vs the deployed copy
npx tgcloud diff                          # line-by-line changes
npx tgcloud run handlers/message '{ chat: { id: 1, type: "private" }, from: { id: 123456789, first_name: "Me" }, text: "hello" }'
npx tgcloud push                          # deploy
npx tgcloud webhook                       # check the webhook matches your handlers
npx tgcloud webhook sync                  # re-sync if it says "out of sync"
```

`tgcloud run` executes your local code on the platform without deploying. It uses the real bot database, so test commands like `/remember` really write notes, and the reply goes to the chat id you pass.

Rules of the runtime: relative imports must end in `.js`, there are no npm packages at runtime, every `db` call needs `await`, and there are no foreign keys. Don't rename `handlers/business_message.js` or `handlers/business_connection.js`: the file name is the Telegram update type it handles.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bot says "Setup mode" | Set `OWNER_ID` in `tgcloud/lib/config.js` and `npx tgcloud push` |
| `⚠️ Ollama rejected the API key` | `/setkey <new key>`. Check the key at ollama.com/settings/keys |
| `⚠️ Ollama doesn't know the model` | Check the exact name for the hosted API (no `:cloud` suffix) with `/model <name>`; the list is at ollama.com/search?c=cloud |
| `⚠️ ... usage limit reached` | Your Ollama plan's cloud usage is used up; wait or upgrade |
| Secretary messages never arrive | Run `npx tgcloud webhook`; if out of sync, `npx tgcloud webhook sync`. Confirm Secretary Mode is enabled in BotFather and the bot is added in Settings → Account → Chat Automation |
| Connected, but it won't reply | In Chat Automation settings, allow "Reply to messages" for the bot; check `/status`, that `/secretary` is on, and that you haven't just replied manually (`/pause`) |
| Nothing happens after changes | You must `npx tgcloud push`. Schema changes also need `npx tgcloud migrate` |
| Bot replies instantly, ignoring the delay | `/status` shows the delay; if it says "timers unavailable", the runtime has no `setTimeout`. Otherwise check `/delay` isn't 0 |
| Fragments aren't merged | The delay is probably shorter than the person's typing gaps; raise `/delay` |

## Known limits

- **No scheduler is documented** for Telegram Serverless, so there are no proactive reminders or daily briefings; the bot only reacts to messages.
- **No secrets store is documented**, hence the Ollama key lives in the database. Anyone with access to your bot's BotFather Serverless panel can see the deployed data.
- Replies are plain text only (model output often breaks Markdown).
- Text only for now. `gemma4:31b` accepts images, so photo support is a natural next step in `message.js` and `business_message.js`.
- **Reply delay caveats:** the wait happens inside the running handler. If the platform cuts a long invocation short, that person's fragments would go unanswered (the bot then merges them into the next reply, but drops anything older than 15 minutes). That's why step 7 has you test your delay length. A message that arrives while the bot is already generating its reply starts its own new cycle.
- Non-text messages (stickers, voice, photos without caption) are not delayed or answered; you get a notification instead.

## License

[MIT](LICENSE)
