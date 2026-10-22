import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The local runtime's query builder, tested against the same shapes the bot uses.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-db-'));
process.env.BOT_STATE_DIR = dir;

const { db, table, integer, text, boolean, index, eq, and, lte, asc, desc } = await import('../bot/sdk/db.mjs');
const { load, save, stats, acquireLock, releaseLock } = await import('../bot/sdk/store.mjs');

load();

const notes = table('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  text: text('text').notNull(),
  created: integer('created_at'),
});

const chats = table('chats', {
  chatId: integer('chat_id').primaryKey(),
  name: text('name'),
  muted: boolean('muted').default(false),
  ownerLastAt: integer('owner_last_at').default(0),
}, (t) => ({ i: index('x').on(t.chatId) }));

test('insert returns rows only when returning() is asked for, and assigns ids', async () => {
  const plain = await db.insert(notes).values({ text: 'one' }).run();
  assert.deepEqual(plain, { rowsAffected: 1 });

  const [row] = await db.insert(notes).values({ text: 'two' }).returning().run();
  assert.equal(row.id, 2);
  assert.equal(row.text, 'two');
});

test('select with where, orderBy, limit and offset', async () => {
  await db.insert(notes).values([{ text: 'three' }, { text: 'four' }]).run();
  const all = await db.select().from(notes).orderBy(asc(notes.id)).all();
  assert.equal(all.length, 4);

  const last = await db.select().from(notes).orderBy(desc(notes.id)).limit(1).get();
  assert.equal(last.text, 'four');

  const second = await db.select({ n: notes.text }).from(notes).orderBy(asc(notes.id)).limit(1).offset(1).get();
  assert.deepEqual(second, { n: 'two' });

  const filtered = await db.select().from(notes).where(and(eq(notes.text, 'three'))).all();
  assert.equal(filtered.length, 1);

  const cutoff = await db.select({ id: notes.id }).from(notes).orderBy(desc(notes.id)).limit(1).offset(2).get();
  assert.equal(cutoff.id, 2);
  const old = await db.delete(notes).where(lte(notes.id, cutoff.id)).run();
  assert.equal(old.rowsAffected, 2);
  assert.equal((await db.select().from(notes).all()).length, 2);
});

test('upsert by primary key applies defaults on the first insert', async () => {
  await db.insert(chats).values({ chatId: 5, name: 'Sara' }).run();
  let row = await db.select().from(chats).where(eq(chats.chatId, 5)).get();
  assert.equal(row.muted, false);
  assert.equal(row.ownerLastAt, 0);

  await db.insert(chats).values({ chatId: 5, muted: true }).onConflictDoUpdate({ target: chats.chatId, set: { muted: true } }).run();
  row = await db.select().from(chats).where(eq(chats.chatId, 5)).get();
  assert.equal(row.muted, true);
  assert.equal(row.name, 'Sara', 'other columns survive an upsert');
  assert.equal((await db.select().from(chats).all()).length, 1, 'no duplicate row');
});

test('everything is persisted, so a restart keeps the data', async () => {
  save();
  const file = path.join(dir, 'bot.json');
  assert.ok(fs.existsSync(file));
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.tables.notes.length, 2);
  assert.equal(parsed.tables.chats[0].chatId, 5);
  assert.ok(stats().bytes > 0);
});

test('a second bot cannot share the state directory', async () => {
  const fs2 = await import('node:fs');
  const path2 = await import('node:path');

  // Pretend another (live) process holds the lock. pid 1 exists and is not us.
  fs2.writeFileSync(path2.join(dir, 'bot.lock'), JSON.stringify({ pid: 1, at: Date.now() }));
  assert.throws(() => acquireLock(), /Another bot is already running/);

  // A stale lock (dead pid) is taken over instead.
  fs2.writeFileSync(path2.join(dir, 'bot.lock'), JSON.stringify({ pid: 999999, at: Date.now() }));
  assert.ok(acquireLock().endsWith('bot.lock'));
  releaseLock();
  assert.equal(fs2.existsSync(path2.join(dir, 'bot.lock')), false);
});
