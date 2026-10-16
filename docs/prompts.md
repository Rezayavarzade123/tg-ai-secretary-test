# System prompts

There are two prompts, one per mode, and both can be changed from chat at runtime, without redeploying:

- **`bot`**: how the bot talks with you in your private chat.
- **`secretary`**: how it answers people who write to your main account.

```
/prompt secretary default        shows the built-in text, so you can copy it and edit it
/prompt secretary You are {owner}'s secretary. Be formal and very brief. ...    replaces it
/prompt secretary append More rules...    adds to your custom prompt (build it in several messages)
/prompt secretary                shows what is in use now (CUSTOM or DEFAULT)
/prompt secretary reset          back to the default
```

Use `{owner}` in your text where the bot should write your name (taken from your Telegram profile name). The change applies from the next message. A prompt can be up to **10,000 characters** (`MAX_PROMPT_CHARS` in `tgcloud/lib/config.js`).

The prompts live in the bot's database, not in the code, so a `push` never overwrites them.

## Long prompts (more than 4096 characters)

A single Telegram message can't hold more than 4096 characters. For a long prompt, write it in a `.txt` or `.md` file (UTF-8, any language) and send the file to the bot with the caption `/prompt secretary` (or `/prompt bot`). The bot reads the file and replaces the prompt with its content.

`/prompt secretary append <text>` is the alternative if you'd rather paste it in pieces.

## What the model actually receives

Your prompt is only one part. The code builds a single system message from sections separated by `---`, in this order:

| Mode | Order |
|---|---|
| `secretary` | 1. anti-hijacking security line, 2. **your base prompt**, 3. your `/secretaryinfo` text, 4. current date/time |
| `bot` | 1. **your base prompt**, 2. your `/notes`, 3. current date/time |

Everything that rarely changes comes first, so the provider can reuse (cache) that whole prefix between messages. The date/time is last because it is the only part that changes: it is rounded down to 10 minutes (`TIME_ROUND_MINUTES` in `lib/config.js`), labeled approximate, and sits right next to the conversation, where models pay the most attention. Whether Ollama's cloud actually caches prompts, and for how long, isn't documented, so treat the saving as a possible bonus, not a promise.

The security line is always there, even with a custom prompt, so a sender can't talk the secretary out of its instructions. Bot mode has no security line, because only you talk to it.

If `/secretaryinfo` is empty, its section still says "(nothing, so do not invent availability or details)". That is deliberate: without it, a model tends to fill the gap with plausible-sounding details like "he's free Tuesday at 3". With the line, it says it doesn't know and takes a message instead. Likewise, empty notes show "(none yet)".

## Cost

Every message also carries up to 20 earlier messages of that conversation (`HISTORY_LIMIT`), so a long prompt is paid for in tokens on every single reply (a 10,000-character prompt is roughly 2,500 to 6,000 tokens, more for non-Latin scripts). Keep it as short as it can be.

## Keep the AI disclosure

The built-in `secretary` prompt tells the assistant to say it is an automated assistant, because replies appear under your name and people can't otherwise tell. If you drop that rule, people will assume they are talking to you. Keep it unless you have a good reason, and see the disclaimer in the main README.
