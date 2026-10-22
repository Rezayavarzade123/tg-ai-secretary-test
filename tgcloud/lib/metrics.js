import { db } from 'sdk';
import { desc, lte } from 'sdk/db';
import { metrics } from '../schema.js';

// Latency and token accounting for every model call.
//
// This exists because of the hardware: on a slow CPU the question is never "did
// the model answer", it is "how many prompt tokens did I pay for, and how long did
// prefill take". llama-server reports both (`timings`), Ollama cloud does not, so the
// numbers may be partial — never invented.

const KEEP = 200;
const nowSec = () => Math.floor(Date.now() / 1000);

export async function recordMetric({ mode, model, usage = {}, ms = 0 }) {
  try {
    await db.insert(metrics).values({
      at: nowSec(),
      mode: mode === 'secretary' ? 'secretary' : 'bot',
      model: model ?? '',
      promptTokens: Math.max(0, Math.round(usage.promptTokens ?? 0)),
      completionTokens: Math.max(0, Math.round(usage.completionTokens ?? 0)),
      promptMs: Math.max(0, Math.round(usage.promptMs ?? 0)),
      decodeMs: Math.max(0, Math.round(usage.decodeMs ?? 0)),
      totalMs: Math.max(0, Math.round(ms)),
    }).run();

    if (Math.random() < 0.05) {
      const cutoff = await db.select({ id: metrics.id }).from(metrics)
        .orderBy(desc(metrics.id)).limit(1).offset(KEEP).get();
      if (cutoff) await db.delete(metrics).where(lte(metrics.id, cutoff.id)).run();
    }
  } catch (e) {
    // Telemetry must never cost a reply.
    console.warn('recordMetric failed:', e?.message ?? e);
  }
}

export async function recentMetrics(limit = 20) {
  const rows = await db.select().from(metrics).orderBy(desc(metrics.id)).limit(limit).all();
  return rows;
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rate = (tokens, ms) => (tokens > 0 && ms > 0 ? tokens / (ms / 1000) : 0);

export function summarize(rows) {
  const withDecode = rows.filter((r) => r.decodeMs > 0 && r.completionTokens > 0);
  const withPrefill = rows.filter((r) => r.promptMs > 0 && r.promptTokens > 0);
  const last = rows[0] ?? null;
  return {
    count: rows.length,
    last: last ? decorate(last) : null,
    avgTotalMs: Math.round(avg(rows.map((r) => r.totalMs).filter(Boolean))),
    avgPromptTokens: Math.round(avg(rows.map((r) => r.promptTokens).filter(Boolean))),
    avgCompletionTokens: Math.round(avg(rows.map((r) => r.completionTokens).filter(Boolean))),
    // tok/s, only over the calls that actually reported timings
    decodeTps: Math.round(avg(withDecode.map((r) => rate(r.completionTokens, r.decodeMs))) * 10) / 10,
    prefillTps: Math.round(avg(withPrefill.map((r) => rate(r.promptTokens, r.promptMs))) * 10) / 10,
    timedCalls: withDecode.length,
  };
}

export function decorate(row) {
  if (!row) return null;
  return {
    ...row,
    decodeTps: Math.round(rate(row.completionTokens, row.decodeMs) * 10) / 10,
    prefillTps: Math.round(rate(row.promptTokens, row.promptMs) * 10) / 10,
  };
}

export async function metricsSummary(limit = 20) {
  return summarize(await recentMetrics(limit));
}
