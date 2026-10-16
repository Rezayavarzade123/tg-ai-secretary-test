import { table, integer, text, boolean, index, sql } from 'sdk/db';

// Key/value settings: Ollama API key, model, custom prompts, secretary info, switches...
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
export const secretaryChats = table('secretary_chats', {
  chatId:      integer('chat_id').primaryKey(),
  name:        text('name'),
  ownerLastAt: integer('owner_last_at').default(0),   // unix seconds of your last manual reply
  muted:       boolean('muted').default(false),
});
