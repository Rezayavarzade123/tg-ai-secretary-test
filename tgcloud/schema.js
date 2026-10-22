import { table, integer, text, boolean, index, sql } from 'sdk/db';

// Key/value settings: model, prompts, secretary info, language, switches...
export const settings = table('settings', {
  key:   text('key').primaryKey(),
  value: text('value').notNull(),
});

// Rolling conversation memory. `scope` is "bot" for your private chat with the bot,
// or "secretary:<chat_id>" for each person who writes to your main account.
export const history = table('history', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  scope:   text('scope').notNull(),
  role:    text('role').notNull(),            // "user" | "assistant"
  content: text('content').notNull(),
  created: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  scopeIdx: index('idx_history_scope').on(t.scope, t.id),
}));

// Your private notes (/remember, /notes, /forget).
export const notes = table('notes', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  text:    text('text').notNull(),
  created: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// Fragments waiting for the reply delay to expire (one queue per chat).
export const pending = table('pending', {
  id:     integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  connId: text('conn_id').notNull(),
  name:   text('name'),
  text:   text('text').notNull(),
  at:     integer('at').notNull(),            // unix seconds
}, (t) => ({
  chatIdx: index('idx_pending_chat').on(t.chatId, t.id),
}));

// People who messaged your main account (Secretary mode).
// `notes` and `lang` are yours: short context about the sender ("Sara is my sister"),
// and an optional reply language for that one chat. `blocked` makes the bot ignore
// the chat completely — no draft, no reply, no model call.
export const secretaryChats = table('secretary_chats', {
  chatId:      integer('chat_id').primaryKey(),
  name:        text('name'),
  ownerLastAt: integer('owner_last_at').default(0),   // unix seconds of your last manual reply
  muted:       boolean('muted').default(false),
  notes:       text('notes').default(''),
  lang:        text('lang').default(''),
  blocked:     boolean('blocked').default(false),
  lastSeenAt:  integer('last_seen_at').default(0),
  // Learning throttle: how many messages have arrived since the last extraction,
  // and when it last ran (unix seconds). Two integers instead of a model call per
  // message — see lib/memory.js.
  msgSinceFacts: integer('msg_since_facts').default(0),
  factsAt:       integer('facts_at').default(0),
}, (t) => ({
  seenIdx: index('idx_chats_seen').on(t.lastSeenAt, t.chatId),
}));

// Facts learned from a person's own messages (lib/memory.js).
//
// Kept apart from `secretary_chats.notes` on purpose: notes are the owner's, and
// trusted. These are the sender's words, filtered for instructions and secrets,
// and injected into the prompt under a label that says they are not instructions.
export const contactFacts = table('contact_facts', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  chatId:  integer('chat_id').notNull(),
  text:    text('text').notNull(),
  kind:    text('kind').default('context'),
  pinned:  boolean('pinned').default(false),
  created: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  chatIdx: index('idx_facts_chat').on(t.chatId, t.id),
}));

// Draft replies waiting for your approval (secretary mode = "draft").
// The bot generates the answer, shows it to you in Telegram and in the control
// panel, and only sends it when you say so.
export const drafts = table('drafts', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  chatId:    integer('chat_id').notNull(),
  connId:    text('conn_id').notNull(),
  name:      text('name'),
  incoming:  text('incoming').notNull(),
  answer:    text('answer').notNull(),
  lang:      text('lang'),
  guard:     text('guard'),                   // JSON list of what the safety net replaced
  status:    text('status').default('pending'), // pending | sent | ignored
  ownerMsgId: integer('owner_msg_id'),        // the card in your chat, so it can be edited
  sentText:  text('sent_text'),               // what actually went out, if edited
  created:   integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  resolved:  integer('resolved_at'),
}, (t) => ({
  statusIdx: index('idx_drafts_status').on(t.status, t.id),
}));

// One row per model call: how long it took and how many tokens went through.
// On a slow machine this is the difference between "the bot is broken" and
// "the prompt is too long" — the panel charts the last 20 calls.
export const metrics = table('metrics', {
  id:          integer('id').primaryKey({ autoIncrement: true }),
  at:          integer('at').notNull(),            // unix seconds
  mode:        text('mode').notNull(),             // bot | secretary
  model:       text('model'),
  promptTokens:     integer('prompt_tokens').default(0),
  completionTokens: integer('completion_tokens').default(0),
  promptMs:    integer('prompt_ms').default(0),    // prefill
  decodeMs:    integer('decode_ms').default(0),    // generation
  totalMs:     integer('total_ms').default(0),
}, (t) => ({
  atIdx: index('idx_metrics_at').on(t.at, t.id),
}));

// Human-readable log for the control panel ("message from Sara", "draft sent"...).
export const activity = table('activity', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  at:      integer('at').notNull(),           // unix seconds
  kind:    text('kind').notNull(),            // info | draft | sent | blocked | error | model
  summary: text('summary').notNull(),
}, (t) => ({
  atIdx: index('idx_activity_at').on(t.at, t.id),
}));
