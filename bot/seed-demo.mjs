// Seed a demo state directory so you can look at the control panel without
// connecting a real bot or having a model running:
//
//   npm run demo
//   BOT_STATE_DIR=./bot/state-demo PANEL_TOKEN=demo npm start
//
// Use a separate state directory (the default below), never your real one.

import path from 'node:path';

process.env.BOT_STATE_DIR ||= path.join(process.cwd(), 'bot', 'state-demo');

const { load } = await import('./sdk/store.mjs');
const { db } = await import('sdk');
const { settings, drafts, notes, activity } = await import('../tgcloud/schema.js');

load();

const now = Math.floor(Date.now() / 1000);

for (const [key, value] of Object.entries({
  owner_id: '123456789',
  owner_name: 'Sam',
  lang: 'en',
  lang_auto: 'on',
  secretary: 'on',
  secretary_mode: 'draft',
  delay_seconds: '50',
  pause_hours: '4',
  notify: 'on',
  model: 'qwen3-1.7b',
  llm_provider: 'local',
  llm_base_url: 'http://127.0.0.1:8080',
  secretary_info: 'Travelling until Friday. For urgent things call my office. Replies may take a day.',
  secretary_conns: '["demo-connection"]',
})) {
  await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

await db.delete(drafts).where(() => true).run();
await db.insert(drafts).values([
  {
    chatId: 5551234,
    connId: 'demo-connection',
    name: 'Sara',
    incoming: 'Hi Sam! Are you free on Friday? We wanted to go over the contract.',
    answer: "Hi Sara — this is Sam's automated assistant. Sam is travelling until Friday, and I've passed your message on. For anything urgent, the office number is best.",
    lang: 'en',
    guard: '[]',
    status: 'pending',
    created: now - 240,
  },
  {
    chatId: 7778888,
    connId: 'demo-connection',
    name: 'رضا',
    incoming: 'سلام، فاکتور را پرداخت کردید؟',
    answer: 'سلام، من دستیار خودکار سام هستم. پیام شما را می‌رسانم و خودشان پاسخ می‌دهند.',
    lang: 'fa',
    guard: '["commitment"]',
    status: 'pending',
    created: now - 900,
  },
  {
    chatId: 9990001,
    connId: 'demo-connection',
    name: 'Nina',
    incoming: 'Is the 3pm call still on?',
    answer: "Hi Nina — this is Sam's automated assistant. I've passed this on and Sam will confirm.",
    lang: 'en',
    guard: '[]',
    status: 'sent',
    sentText: "Hi Nina — this is Sam's automated assistant. I've passed this on and Sam will confirm.",
    created: now - 7200,
    resolved: now - 7100,
  },
]).run();

await db.delete(notes).where(() => true).run();
await db.insert(notes).values([
  { text: 'Passport expires in May — renew before the Berlin trip.' },
  { text: 'Sara is the main contact for the contract, not the office.' },
  { text: 'Office hours: Mon–Fri 9–17, Tehran time.' },
]).run();

await db.delete(activity).where(() => true).run();
await db.insert(activity).values([
  { at: now - 120, kind: 'info', summary: 'Polling started; bot connected as @secretary_bot' },
  { at: now - 240, kind: 'draft', summary: 'Draft for Sara (chat 5551234)' },
  { at: now - 600, kind: 'blocked', summary: 'Emergency-sounding message from Omid answered with the fixed escalation text.' },
  { at: now - 900, kind: 'draft', summary: 'Draft for رضا (chat 7778888) — guards: commitment' },
  { at: now - 7100, kind: 'sent', summary: 'Sent to Nina (chat 9990001)' },
  { at: now - 7200, kind: 'info', summary: 'Nina (chat 9990001): Is the 3pm call still on?' },
]).run();

const { stats } = await import('./sdk/store.mjs');
console.log('Demo state written to', process.env.BOT_STATE_DIR);
console.log('Rows:', stats().counts);
console.log('\nNow run:');
console.log('  BOT_STATE_DIR=' + process.env.BOT_STATE_DIR + ' PANEL_TOKEN=demo npm start');
console.log('and open http://<machine-ip>:8787/?token=demo');
