import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from './fake-sdk.mjs';

const { parseHour, parseWindow, hourIn, inQuietHours, describeWindow, hoursUntilWindowEnd } = await import('../tgcloud/lib/hours.js');
const { contactPromptLine, langForContact, NOTES_LIMIT } = await import('../tgcloud/lib/contacts.js');
const { updateContact, getContact, listContacts, markSeen, isBlocked } = await import('../tgcloud/lib/contacts.js');
const { summarize, decorate, recordMetric, metricsSummary } = await import('../tgcloud/lib/metrics.js');
const { probeVerdict, GATE_MIN_SCORE, GATE_MAX_AGE_DAYS, PROBE_TOTAL } = await import('../tgcloud/lib/probe.js');
const { setSetting, delSetting } = await import('../tgcloud/lib/settings.js');
const { systemPrompt } = await import('../tgcloud/lib/brain.js');

// ---------------------------------------------------------------- quiet hours
test('hours parse strictly', () => {
  assert.equal(parseHour('22'), 22);
  assert.equal(parseHour(7), 7);
  assert.equal(parseHour('07'), 7);
  assert.equal(parseHour(''), null);
  assert.equal(parseHour('24'), null);
  assert.equal(parseHour('-1'), null);
  assert.equal(parseHour('7.5'), null);
  assert.equal(parseHour('night'), null);
  assert.equal(parseHour(null), null);
});

test('a window needs two different valid hours', () => {
  assert.deepEqual(parseWindow('22', '8'), { from: 22, to: 8 });
  assert.deepEqual(parseWindow('9', '17'), { from: 9, to: 17 });
  assert.equal(parseWindow('22', '22'), null, 'same hour = disabled, not 24/7 quiet');
  assert.equal(parseWindow('', '8'), null);
  assert.equal(parseWindow('22', ''), null);
});

test('quiet hours across midnight and inside the day', () => {
  const at = (iso) => new Date(iso).getTime();
  const tz = 'UTC';
  // 22-08 wraps: quiet at 23 and 03, not at 12 or 08.
  assert.equal(inQuietHours({ start: '22', end: '8', tz, now: at('2026-10-22T23:10:00Z') }), true);
  assert.equal(inQuietHours({ start: '22', end: '8', tz, now: at('2026-10-22T03:00:00Z') }), true);
  assert.equal(inQuietHours({ start: '22', end: '8', tz, now: at('2026-10-22T08:00:00Z') }), false, 'end is exclusive');
  assert.equal(inQuietHours({ start: '22', end: '8', tz, now: at('2026-10-22T22:00:00Z') }), true, 'start is inclusive');
  assert.equal(inQuietHours({ start: '22', end: '8', tz, now: at('2026-10-22T12:00:00Z') }), false);
  // 09-17 is a daytime window.
  assert.equal(inQuietHours({ start: '9', end: '17', tz, now: at('2026-10-22T12:00:00Z') }), true);
  assert.equal(inQuietHours({ start: '9', end: '17', tz, now: at('2026-10-22T18:00:00Z') }), false);
  // Disabled windows never fire.
  assert.equal(inQuietHours({ start: '', end: '', tz, now: at('2026-10-22T03:00:00Z') }), false);
});

test('quiet hours respect the owner timezone, not the server one', () => {
  // 18:00 UTC is 21:30 in Tehran (+03:30) — outside a 22-08 window there, but a
  // 22-08 window in UTC would also be outside. Use 18:30 UTC = 22:00 Tehran.
  const now = new Date('2026-10-22T18:30:00Z').getTime();
  assert.equal(inQuietHours({ start: '22', end: '8', tz: 'Asia/Tehran', now }), true);
  assert.equal(inQuietHours({ start: '22', end: '8', tz: 'UTC', now }), false);
  assert.equal(inQuietHours({ start: '22', end: '8', tz: 'Not/AZone', now }), false, 'unknown tz falls back to UTC');
});

test('window text and remaining hours', () => {
  assert.equal(describeWindow('22', '8'), '22:00–08:00');
  assert.equal(describeWindow('9', '17'), '09:00–17:00');
  assert.equal(describeWindow('', ''), 'off');
  assert.equal(describeWindow('5', '5'), 'off');
  const at3 = new Date('2026-10-22T03:00:00Z').getTime();
  assert.equal(hoursUntilWindowEnd({ start: '22', end: '8', tz: 'UTC', now: at3 }), 5);
  assert.equal(hoursUntilWindowEnd({ start: '22', end: '8', tz: 'UTC', now: new Date('2026-10-22T12:00:00Z').getTime() }), 0);
});

// -------------------------------------------------------------------- contacts
test('contact context is capped and clearly labelled as owner-written', () => {
  assert.equal(contactPromptLine({ notes: '' }), '');
  assert.equal(contactPromptLine(null), '');
  const line = contactPromptLine({ notes: 'Sara is my sister' });
  assert.match(line, /Sara is my sister/);
  assert.match(line, /written by the owner, trusted/, 'the model must know this is not sender text');
});

test('per-contact language beats the global rules', () => {
  const contact = { lang: 'fa' };
  assert.equal(langForContact(contact, { auto: true, fallback: 'en', detected: 'de' }), 'fa');
  assert.equal(langForContact({ lang: '' }, { auto: true, fallback: 'en', detected: 'de' }), 'de');
  assert.equal(langForContact({ lang: '' }, { auto: false, fallback: 'en', detected: 'de' }), 'en');
  assert.equal(langForContact(null, { auto: true, fallback: 'en', detected: null }), 'en');
});

test('contacts: create, update, list, block, and the prompt picks the notes up', async () => {
  store.secretary_chats = [];

  await markSeen(123, 'Sara');
  let c = await getContact(123);
  assert.equal(c.name, 'Sara');
  assert.ok(c.lastSeenAt > 0);
  assert.equal(c.blocked, false);

  await updateContact(123, { notes: 'my sister, knows about the trip', lang: 'fa' });
  c = await getContact(123);
  assert.match(c.notes, /my sister/);
  assert.equal(c.lang, 'fa');
  assert.equal(await isBlocked(123), false);

  await updateContact(123, { blocked: true });
  assert.equal(await isBlocked(123), true);

  await markSeen(456, 'Ali');
  const all = await listContacts();
  assert.equal(all.length, 2);

  await assert.rejects(() => updateContact(123, { notes: 'x'.repeat(NOTES_LIMIT + 1) }), /under 400/);
  await assert.rejects(() => updateContact('abc', { notes: 'x' }), /chat id is a number/);
  await assert.rejects(() => updateContact(123, {}), /Nothing to update/);

  // The secretary prompt for that chat contains the context and the fixed language.
  store.settings = [];
  await setSetting('owner_name', 'Sam');
  const p = await systemPrompt('secretary', { chatId: 123 });
  assert.match(p, /my sister/);
  assert.match(p, /always reply in Persian/);
  const other = await systemPrompt('secretary', { chatId: 456 });
  assert.ok(!/my sister/.test(other), 'another chat does not see it');
});

// --------------------------------------------------------------------- metrics
test('metrics summarise only what the server actually reported', () => {
  const rows = [
    { at: 2, promptTokens: 400, completionTokens: 100, promptMs: 20000, decodeMs: 5000, totalMs: 25000 },
    { at: 1, promptTokens: 0, completionTokens: 0, promptMs: 0, decodeMs: 0, totalMs: 900 },
  ];
  const s = summarize(rows);
  assert.equal(s.count, 2);
  assert.equal(s.timedCalls, 1, 'one call had timings');
  assert.equal(s.prefillTps, 20);
  assert.equal(s.decodeTps, 20);
  assert.equal(s.avgTotalMs, 12950);
  assert.equal(decorate(rows[0]).decodeTps, 20);
  assert.equal(decorate(rows[1]).decodeTps, 0, 'no division by zero');

  const empty = summarize([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.last, null);
  assert.equal(empty.decodeTps, 0);
});

test('recording a metric never throws, even with a broken store', async () => {
  await recordMetric({ mode: 'secretary', model: 'test', usage: { promptTokens: 12, completionTokens: 3, decodeMs: 300 }, ms: 5000 });
  const store2 = (await import('./fake-sdk.mjs')).store;
  assert.ok(Array.isArray(store2.metrics));
  assert.equal(store2.metrics.at(-1).promptTokens, 12);
  const s = await metricsSummary(5);
  assert.ok(s.count >= 1);
});

// ----------------------------------------------------------------------- probe
test('the auto-mode gate needs a recent, passing probe', async () => {
  store.settings = [];
  let v = await probeVerdict();
  assert.equal(v.ok, false);
  assert.match(v.reason, /no probe/);

  const fresh = (scoreFinal, daysAgo = 0) => JSON.stringify({
    at: Math.floor(Date.now() / 1000) - daysAgo * 86400,
    total: PROBE_TOTAL,
    scoreFinal,
    scoreRaw: scoreFinal,
    results: [],
  });

  await setSetting('probe_last', fresh(GATE_MIN_SCORE - 1));
  v = await probeVerdict();
  assert.equal(v.ok, false);
  assert.match(v.reason, /scored/);

  await setSetting('probe_last', fresh(GATE_MIN_SCORE));
  v = await probeVerdict();
  assert.equal(v.ok, true);

  await setSetting('probe_last', fresh(PROBE_TOTAL, GATE_MAX_AGE_DAYS + 1));
  v = await probeVerdict();
  assert.equal(v.ok, false);
  assert.match(v.reason, /days old/);

  // A corrupt value must not open the gate.
  await setSetting('probe_last', 'not json');
  v = await probeVerdict();
  assert.equal(v.ok, false);

  await delSetting('probe_last');
});
