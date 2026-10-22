# Secretary Bot

A Telegram AI assistant and secretary that can answer as **your** automated assistant, with two ways to run it:

| | **Local runtime** (new) | **Telegram Serverless** |
|---|---|---|
| Where it runs | Your own machine — a Linux PC, a mini-PC, a Raspberry Pi, even a PS4 with Linux | Telegram's cloud |
| Brain | **A small model on your own hardware** (llama.cpp / Ollama), no API key | Ollama's hosted API with your key |
| Secretary mode | Yes | Yes |
| Cost | Electricity | Your Ollama plan |
| Needs a public address | No — long polling | No — Telegram calls you |
| Good for | Privacy, offline, no quota, 1–2B models | Zero maintenance, bigger models |

Both use the same handlers, the same database schema and the same prompts. The local runtime provides a **control panel** in the browser; Telegram gets `/lang`, `/mode` and inline-button approvals.

> **Status:** experimental. The local runtime has unit tests plus an end-to-end self test (`npm run selftest`, 15 checks) that covers connections, drafts, approvals, the safety net and the panel API. It has **not** been tested on real PS4 hardware or against a live Telegram account in this repository — the first thing to do is connect your own bot and send it a message.

## What it does

A Telegram bot is its own account, so it can't read your main account's chats by itself. This project gives you two modes:

| Mode | How it works | Needs |
|---|---|---|
| **Bot mode** | You chat with the bot in your private chat. It remembers the conversation, keeps your private notes and answers questions. | A free Telegram account |
| **Secretary mode** | The bot is connected to your main account. When people message you, it answers for you, openly as your AI secretary, and copies you on everything. | **Secretary Mode** enabled for the bot in BotFather (called *Business Mode* in older Telegram docs), then the bot added under **Settings → Account → Chat Automation** |

### How secretary replies work

Telegram's API can post from your account on behalf of the bot. With a small local model that is enough rope to embarrass yourself, so replies have three settings (`/mode`, or the panel):

- **Draft (default)** — the bot writes the reply and sends **you** a card with ✅ Send / 🔁 Regenerate / 🚫 Ignore. Nothing reaches the other person until you approve it. The same drafts are editable in the control panel.
- **Auto** — it answers by itself, but every reply passes the deterministic safety net in `tgcloud/lib/guard.js` first: claims to be you, promises, prices, appointments, "I'll call you", times of day and long replies are replaced with a fixed, safe sentence. Emergency-sounding messages never reach the model at all: they get a fixed "call emergency services" text.
- **Off** — it never answers anyone on your account.

### Features

- **Reply delay ("breathing time"):** waits after a person's *last* message (default 50 s, `/delay <seconds>`) and answers all their fragments at once. The timer is per person.
- **"typing…" indicator** while the model is working, refreshed every 4 seconds.
- **Draft approvals in Telegram** (inline buttons) and in the control panel.
- **Language control:** `/lang fa` fixes the reply language, `/lang auto on` follows whoever writes. Detection is local and dependency-free (script test + stop-words), so a 1–2B model can't drift into English halfway through.
- **Privacy:** only what you wrote with `/secretaryinfo` may be shared. Your private notes never leave bot mode.
- **Editable system prompts**, live, from `/prompt` or the panel. See [docs/prompts.md](docs/prompts.md).
- **Safeguards:** acts only on connections created by you, ignores other bots, always says it's an automated assistant, makes no promises or payments.
- **Stays out of your way:** quiet after *you* reply manually in a chat (`/pause`), per-chat mute, `/secretary off`.

### Disclaimer

In secretary mode, replies appear in the chat as sent by **your** account, and the other person has no built-in way to tell an AI wrote them. You are responsible for telling people they are talking to an AI (the default prompt does this, so keep that rule) and for complying with the laws and platform rules that apply to you. Messages you receive are sent to your model and stored in the bot's database. Don't use this for conversations where that isn't acceptable. The software is provided as is (see [LICENSE](LICENSE)).

---

## Run it on your own machine

### Quick start

```bash
git clone https://github.com/ygasaino1/tg-ai-secretary.git   # or your fork
cd tg-ai-secretary
npm install                       # only needed for the serverless tooling; the runtime has zero dependencies
cp bot/.env.example bot/.env      # paste your bot token from @BotFather
chmod 600 bot/.env
npm start
```

Then:

1. Open the control panel at the address printed at start-up (`http://<machine-ip>:8787/?token=…`).
2. Send `/claim` to your bot in Telegram — that makes you the owner.
3. In **Setup**, check the model server URL, then press **Try the model** on the dashboard.
4. For secretary mode: **Settings → Account → Chat Automation** on your phone, pick the bot, allow **Reply to messages**. The bot confirms the connection and starts sending you drafts.

### The model server

Any OpenAI-compatible server works. For a small machine, llama.cpp is the right choice:

```bash
# build once, on the machine that will run it
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON
cmake --build build -j"$(nproc)"

# a 1.7B Q4 model: ~1.1 GB of RAM, the realistic sweet spot below 2B
./build/bin/llama-server \
  -m /opt/models/Qwen3-1.7B-Instruct-Q4_K_M.gguf \
  -c 4096 -np 1 -t "$(nproc)" --jinja --host 127.0.0.1 --port 8080
```

`-np 1` matters: one slot keeps the prompt cache warm, and the bot serialises its own model calls to match. Ollama also works — set the server URL to `http://127.0.0.1:11434/v1`.

For the PS4 specifics (build flags, thermals, boot injection, systemd units), see **[docs/local.md](docs/local.md)**; for the sizing and design reasoning, **[docs/plan-local-ps4.md](docs/plan-local-ps4.md)**.

### The control panel

`bot/panel` serves a single page, on the same process as the bot, with:

- **Dashboard** — model online/offline and latency, queue state, RAM, load, temperature, update counters, "try the model", database backup.
- **Secretary** — draft/auto/off, language + follow-the-sender switch, reply delay, pause hours, notification switch, what the assistant may share.
- **Drafts** — every pending reply, editable, with Send / Regenerate / Ignore.
- **Prompts** — custom or default prompt for each mode, with the security line always added by the code.
- **Notes**, **Activity** (messages, guards, errors), **Setup** (bot token, owner id, model server, API key, timezone).

It writes the same `settings` rows the Telegram commands write, so the two front doors can't disagree.

Security: the panel is for your LAN. It prints a random token on first run (`bot/state/panel-token`), requires it, and binds to `0.0.0.0:8787` by default. Set `PANEL_HOST=127.0.0.1` to keep it on the machine, or `PANEL_TOKEN` for a fixed token. **Do not port-forward it.**

### Running it as a service

```ini
# /etc/systemd/system/secretary.service
[Unit]
Description=Telegram secretary
After=network-online.target llama-server.service
Wants=network-online.target

[Service]
Type=simple
User=secretary
WorkingDirectory=/opt/tg-ai-secretary
EnvironmentFile=/etc/secretary.env
ExecStart=/usr/bin/node --import ./bot/register.mjs bot/runner.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/secretary.env` holds `BOT_TOKEN` and friends (mode 0600). The bot is long polling, so it needs no inbound port, no tunnel and no certificate.

### Demo without a bot

```bash
npm run demo                        # writes bot/state-demo with sample drafts and notes
BOT_STATE_DIR=./bot/state-demo PANEL_TOKEN=demo npm start
# open http://localhost:8787/?token=demo
```

### Tests

```bash
npm test          # 41 unit tests: text, prompts, delay, typing, language, guards, local db
npm run selftest  # 15 end-to-end checks with fake Telegram + fake model
```

---

## Setup (Telegram Serverless)

The original, no-server route. Useful if you don't want a machine running at home; it uses Ollama's hosted API, so the model size is not limited by your hardware.

### 0. Prerequisites

- Node.js 18 or newer
- An Ollama account and API key: <https://ollama.com/settings/keys>
- For secretary mode: a Telegram app that shows **Settings → Account → Chat Automation**

### 1. Create the bot and switch Serverless on

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Open your bot → **Serverless** → turn it on.
3. For secretary mode, also enable **Secretary Mode** in the bot's settings.
4. **Serverless → CLI Access → Access token**, copy the token (`app<id>:<secret>`).

### 2. Get the code and log in

```bash
git clone https://github.com/ygasaino1/tg-ai-secretary.git
cd tg-ai-secretary
npm install
npx tgcloud login
```

### 3. Deploy, migrate, claim

```bash
npx tgcloud push
npx tgcloud migrate     # also creates the drafts + activity tables
```

Then send `/claim` to your bot (or set `OWNER_ID` in `tgcloud/lib/config.js` and push again).

### 4. Give it a brain

`/setkey <your ollama key>`, then `/model gemma4:31b`. Change the brain shape any time with `/model`.

### 5. Connect your main account

Deploy first, then on your phone: **Settings → Account → Chat Automation**, pick the bot, allow **Reply to messages**. You get a "🔗 Secretary mode is connected" message. Then `/secretaryinfo <what it may share>` and choose `/mode draft`.

### 6. Check the reply delay

Send `/waittest 60`, then `/status` immediately. If `/status` answers right away, waits don't block other chats. Keep `/delay` below whatever survives.

---

## Commands

| Command | What it does |
|---|---|
| *(any text)* | Talk to your assistant (bot mode) |
| `/claim` | Make yourself the owner (first run only) |
| `/mode draft\|auto\|off` | How secretary replies are handled |
| `/lang`, `/lang <code>`, `/lang auto on\|off` | Reply language |
| `/panel` | Where the control panel is |
| `/remember <text>`, `/notes`, `/forget <id>` | Private notes, used in bot mode only |
| `/reset` | Clear bot-mode conversation memory |
| `/secretary on\|off` | Master switch |
| `/secretaryinfo <text>` | The only information the secretary may share |
| `/delay <seconds>` | Wait after a person's last message (default 50, 0 = off, max 300) |
| `/pause <hours>` | Quiet period after you reply manually (default 4) |
| `/notify on\|off` | Copy every secretary reply to you |
| `/mute <chat_id>`, `/unmute <chat_id>` | Per-chat switch |
| `/prompt bot\|secretary [show\|default\|reset\|append <text>\|<text>]` | View or replace a system prompt. See [docs/prompts.md](docs/prompts.md) |
| `/status` | Model, server health, mode, language, drafts waiting |
| `/model [name]`, `/setkey`, `/id`, `/waittest` | Setup and diagnostics |

---

## Project layout

```
tg-ai-secretary/
├─ bot/                        the local runtime (not deployed by tgcloud)
│  ├─ runner.mjs                  long polling + dispatch + serialised model queue
│  ├─ register.mjs, hooks.mjs     maps `sdk` / `sdk/db` to the local shim
│  ├─ env.mjs                     tiny .env reader
│  ├─ sdk/                        store (JSON), query builder, Telegram client
│  ├─ panel/                      control panel: server.mjs + ui.html
│  ├─ selftest.mjs                end-to-end test with a fake Telegram and model
│  ├─ seed-demo.mjs               sample data for looking at the panel
│  └─ state/                      your data (git-ignored): bot.json, panel-token
├─ tgcloud/                    runs on both runtimes
│  ├─ schema.js                   settings, history, notes, pending, chats, drafts, activity
│  ├─ handlers/
│  │  ├─ message.js               bot mode: you + all /commands
│  │  ├─ business_connection.js   secretary mode: connect/disconnect
│  │  └─ business_message.js      secretary mode: incoming messages → auto or draft
│  └─ lib/
│     ├─ config.js                defaults, all overridable from the environment
│     ├─ brain.js                 prompts + memory + model call
│     ├─ llm.js                   local (OpenAI-compatible) and cloud adapters
│     ├─ guard.js                 the deterministic safety net
│     ├─ drafts.js                draft storage, cards, approvals
│     ├─ lang.js                  language registry + detection
│     ├─ owner.js                 who the owner is (env or the database)
│     ├─ secretary.js             connections, per-chat pause/mute
│     ├─ pending.js               per-person queue behind the reply delay
│     ├─ activity.js              the log the panel shows
│     ├─ telegram.js, settings.js, text.js, wait.js
├─ tests/                      unit tests (local fake sdk)
├─ docs/                       prompts.md, local.md, plan-local-ps4.md
└─ package.json
```

## Developing

```bash
npm test && npm run selftest   # do this after touching handlers, guards or the panel
npm start                      # local runtime
npm run dev                    # same, with --watch
npx tgcloud status             # serverless: what changed vs the deployed copy
npx tgcloud push               # deploy (serverless)
```

Rules of the serverless runtime: relative imports must end in `.js`, there are no npm packages at runtime, every `db` call needs `await`, no foreign keys. The local runtime has no such limits, but the handlers are shared, so keep them portable: no `node:` imports inside `tgcloud/`, and only the `db`/`api`/`fetch` surface the shim provides (`bot/sdk`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel asks for a token you don't have | It is in `bot/state/panel-token`, printed at start-up, or open `/?token=…` |
| Bot never answers in Telegram | Panel → Dashboard: is the bot connected? Is `lastError` set? A rejected token shows as a 401 from `getMe` |
| "Telegram says a webhook or another poller is active" | A serverless deployment or a second copy is running. Stop it; the runner removes the webhook itself |
| Model server offline in the panel | Start `llama-server`; check the URL in Setup; `curl http://127.0.0.1:8080/v1/models` |
| Replies take a minute | That is prefill on a small CPU. Lower `HISTORY_LIMIT`, keep replies short (`NUM_PREDICT_SECRETARY`), and run `-np 1` |
| Secretary messages never arrive | Confirm Secretary Mode in BotFather, the bot added in Chat Automation, and "Reply to messages" allowed |
| Drafts arrive but nothing is sent | That is draft mode. Press ✅ Send, or switch to `/mode auto` |
| `⚠️ Setup mode` | Send `/claim`, or set the owner id in Setup |
| Nothing happens after changes (serverless) | `npx tgcloud push`; schema changes also need `npx tgcloud migrate` |

## Known limits

- **Small models are small.** Below 2B, instruction-following is uneven: expect drift, occasional invented details and weak reasoning. That is why drafts are the default and the guard is code, not prompt text.
- **The PS4 has no usable GPU compute** for this (no ROCm for GCN 1.0). CPU-only, AVX but no AVX2/FMA. See the sizing notes in [docs/plan-local-ps4.md](docs/plan-local-ps4.md).
- **A console needs the exploit re-injected after every power cycle.** A local runtime on a PS4 is not a 24/7 service.
- **No scheduler:** there are no proactive reminders or daily briefings; the bot only reacts to messages.
- Text only. Photos, voice and stickers are announced to you, not answered.
- Replies are plain text (model output breaks Markdown).
- **Serverless only:** the Ollama key lives in the database because that runtime documents no secrets store. The local runtime reads it from `bot/.env` / the panel instead.

## License

[MIT](LICENSE)
