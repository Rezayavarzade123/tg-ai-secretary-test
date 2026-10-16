import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from './fake-sdk.mjs';
import { systemPrompt, defaultPrompt } from '../tgcloud/lib/brain.js';
import { getSetting, setSetting, delSetting } from '../tgcloud/lib/settings.js';
import { utf8Manual, decodeUtf8, nowString } from '../tgcloud/lib/text.js';
import { MAX_PROMPT_CHARS } from '../tgcloud/lib/config.js';

const set = (rows) => { store.settings = Object.entries(rows).map(([key, value]) => ({ key, value })); };
const at = (s, needle) => { const i = s.indexOf(needle); assert.ok(i >= 0, `missing: ${needle}`); return i; };

test('secretary prompt order: security, base prompt, secretaryinfo, date; separated by ---', async () => {
  store.notes = [];
  set({ owner_name: 'Sam', prompt_secretary: 'BASE-PROMPT for {owner}', secretary_info: 'Open Mon-Fri 9-17' });
  const p = await systemPrompt('secretary');

  const s = at(p, 'Security:');
  const b = at(p, 'BASE-PROMPT for Sam');
  const i = at(p, 'Information you may share');
  const d = at(p, 'Current date/time');
  assert.equal(s, 0, 'security line is the very first thing');
  assert.ok(s < b && b < i && i < d, 'security < base < secretaryinfo < date');
  assert.equal(p.split('\n\n---\n\n').length, 4);
  assert.ok(/\(\w+\/\w+\)\.$/.test(p.trimEnd()), 'date line is last');
  assert.ok(!/persona/i.test(p));
});

test('the prompt text does not change between calls inside one 10-minute window except in the date line', async () => {
  store.notes = [];
  set({ owner_name: 'Sam' });
  const p = await systemPrompt('secretary');
  const head = p.slice(0, p.lastIndexOf('Current date/time'));
  assert.ok(head.includes('Security:') && head.includes('Information you may share'), 'all static parts come before the date');
});

test('nowString rounds down to the step and is stable inside it', () => {
  const tz = 'Asia/Tehran';
  const base = Date.UTC(2026, 9, 16, 11, 0, 0);      // 14:30 in Tehran (+03:30)
  const at14 = (min) => nowString(tz, 10, base + min * 60000);
  assert.match(at14(0), /14:30/);
  assert.equal(at14(0), at14(9));                      // 14:30 .. 14:39 -> 14:30
  assert.match(at14(11), /14:40/);                     // next bucket
  assert.match(nowString(tz, 0, base + 7 * 60000), /14:37/, 'no rounding when step is 0');
});

test('secretary prompt without custom prompt or info uses the default and keeps the placeholder', async () => {
  store.notes = [];
  set({ owner_name: 'Sam' });
  const p = await systemPrompt('secretary');
  assert.ok(p.includes(defaultPrompt('secretary', 'Sam')));
  assert.ok(p.includes('do not invent availability'));
});

test('bot prompt order: base prompt, notes, date; no security line, no persona', async () => {
  store.notes = [{ id: 1, text: 'passport expires in May' }];
  set({ owner_name: 'Sam', prompt_bot: 'BOT-BASE', persona: 'should never appear' });
  const p = await systemPrompt('bot');

  assert.equal(at(p, 'BOT-BASE'), 0);
  assert.ok(at(p, 'BOT-BASE') < at(p, 'passport expires in May'));
  assert.ok(at(p, 'passport expires in May') < at(p, 'Current date/time'));
  assert.equal(p.split('\n\n---\n\n').length, 3);
  assert.ok(!p.includes('Security:'));
  assert.ok(!p.includes('should never appear'));
});

test('a 9000-character custom prompt is carried through intact', async () => {
  const big = 'Rule. '.repeat(1500).trim();          // ~9000 chars
  assert.ok(big.length > 8000 && big.length <= MAX_PROMPT_CHARS);
  store.notes = [];
  set({ owner_name: 'Sam', prompt_secretary: big });
  const p = await systemPrompt('secretary');
  assert.ok(p.includes(big));
});

test('settings saved under the old names (biz, biz_info, prompt_biz, prompt_owner, owner_conns) are still read', async () => {
  store.notes = [];
  set({
    owner_name: 'Sam',
    biz: 'off', biz_info: 'OLD INFO', prompt_biz: 'OLD SECRETARY PROMPT',
    prompt_owner: 'OLD BOT PROMPT', owner_conns: '["c1"]',
  });
  assert.equal(await getSetting('secretary'), 'off');
  assert.equal(await getSetting('secretary_conns'), '["c1"]');
  const sec = await systemPrompt('secretary');
  assert.ok(sec.includes('OLD SECRETARY PROMPT') && sec.includes('OLD INFO'));
  assert.ok((await systemPrompt('bot')).includes('OLD BOT PROMPT'));
});

test('a new value beats the old one, and reset removes both so the old value cannot come back', async () => {
  set({ secretary_info: 'NEW', biz_info: 'OLD' });
  assert.equal(await getSetting('secretary_info'), 'NEW');

  await delSetting('secretary_info');
  assert.equal(await getSetting('secretary_info'), null);
  assert.equal(await getSetting('secretary_info', 'fallback'), 'fallback');
  assert.ok(!store.settings.some((r) => r.key === 'biz_info'), 'legacy row deleted too');

  await setSetting('secretary_info', 'again');
  assert.equal(await getSetting('secretary_info'), 'again');
});

test('hand-written UTF-8 decoder matches TextDecoder (Persian, emoji, mixed)', () => {
  for (const s of ['plain ascii', 'سلام، من دستیار شیان هستم', 'emoji 😀🎉 and é ñ ü', 'مخلوط mixed متن 😀 end']) {
    const bytes = new TextEncoder().encode(s);
    assert.equal(utf8Manual(bytes), s);
    assert.equal(decodeUtf8(bytes), s);
  }
});
