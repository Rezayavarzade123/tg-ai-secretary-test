import { fetch } from 'sdk';
import { LOCAL_LLM_URL, LLM_API_KEY, OLLAMA_URL, LLM_TIMEOUT_MS } from './config.js';
import { stripThink } from './text.js';

// The model adapter.
//
// Two providers behind one function:
//   "local" -> any OpenAI-compatible server on this machine or the LAN.
//              llama-server (llama.cpp) serves /v1/chat/completions, and so does
//              Ollama if you point LLM_BASE_URL at http://127.0.0.1:11434/v1.
//   "cloud" -> Ollama's hosted API (the original behaviour).
//
// Everything above this file only ever sees { text } or a readable Error, so the
// prompts, history and handlers do not care which brain is answering.

const trimUrl = (u) => String(u || '').replace(/\/+$/, '');

function withTimeout(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(ms) };
  }
  return {};
}

function friendlyNetworkError(e, baseUrl) {
  const detail = e?.message ?? String(e);
  const err = new Error(
    `Can't reach the model server at ${baseUrl} (${detail}). ` +
    'Start it (sudo systemctl start llama-server) or change the server URL in the control panel.'
  );
  err.code = 'LLM_UNREACHABLE';
  return err;
}

// --- local / OpenAI-compatible -------------------------------------------------
export async function localChat({ baseUrl = LOCAL_LLM_URL, apiKey = '', model, messages, maxTokens = 700, temperature = 0.6, timeoutMs = LLM_TIMEOUT_MS }) {
  const url = `${trimUrl(baseUrl)}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      ...withTimeout(timeoutMs),
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        max_tokens: maxTokens,
        temperature,
        // llama.cpp ignores unknown fields; this one keeps Qwen3 from burning
        // hundreds of hidden reasoning tokens on a chat reply.
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(`The model did not answer within ${Math.round(timeoutMs / 1000)} s. It may be loading, or the machine is too busy.`);
    }
    throw friendlyNetworkError(e, baseUrl);
  }

  const raw = await res.text();

  if (!res.ok) {
    if (res.status === 400 && /exceed|context/i.test(raw)) {
      throw new Error('The conversation is longer than the model\u2019s context window. Lower HISTORY_LIMIT or raise -c on the server.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('The model server rejected the API key (HTTP ' + res.status + '). Check the key in the control panel.');
    }
    if (res.status === 404) {
      throw new Error(`The model server doesn't know "${model}". Check the name with /model, or leave it empty to use the server's default.`);
    }
    if (res.status === 429) {
      throw new Error('The model is rate-limited (HTTP 429). Try again in a moment.');
    }
    if (res.status === 503) {
      throw new Error('The model server is not ready (HTTP 503) — it is probably still loading the model. Try again in a few seconds.');
    }
    throw new Error(`Model server error ${res.status}: ${raw.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('The model server returned a non-JSON response: ' + raw.slice(0, 200));
  }

  const msg = data?.choices?.[0]?.message ?? {};
  return stripThink(msg.content ?? '');
}

// --- Ollama hosted (cloud) -----------------------------------------------------
export async function cloudChat({ apiKey, model, messages, maxTokens = 700, temperature = 0.6, timeoutMs = LLM_TIMEOUT_MS }) {
  if (!apiKey) throw new Error('No cloud API key saved. Add one in the control panel, or switch the brain to "local".');

  let res;
  try {
    res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      ...withTimeout(timeoutMs),
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: { num_predict: maxTokens, temperature },
      }),
    });
  } catch (e) {
    throw friendlyNetworkError(e, 'ollama.com');
  }

  const raw = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('Ollama rejected the API key (HTTP ' + res.status + '). Update it in the control panel.');
    }
    if (res.status === 404) throw new Error(`Ollama doesn't know the model "${model}". Check the name with /model.`);
    if (res.status === 429) throw new Error('Ollama rate/usage limit reached (HTTP 429). Try again later.');
    throw new Error(`Ollama error ${res.status}: ${raw.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('Ollama returned a non-JSON response: ' + raw.slice(0, 200));
  }
  return stripThink(data?.message?.content ?? '');
}

// One generation at a time.
//
// On the machine this is built for (8 slow cores, a single llama-server slot) two
// parallel replies are slower than two sequential ones: each one evicts the other's
// cached prompt, so both pay the full prefill again. Serialising keeps the slot's
// cache warm and makes the wait predictable. Inside Telegram Serverless there is
// only one invocation at a time anyway, so this is a no-op there.
let chain = Promise.resolve();
export const llmQueue = { pending: 0, active: false };

function serialize(fn) {
  llmQueue.pending += 1;
  const run = chain.then(fn, fn).finally(() => {
    llmQueue.pending -= 1;
  });
  chain = run.then(() => { llmQueue.active = false; }, () => { llmQueue.active = false; });
  llmQueue.active = true;
  return run;
}

// The one function the rest of the codebase calls.
export function chat(args) {
  return serialize(() => doChat(args));
}

async function doChat({ provider = 'local', apiKey = LLM_API_KEY, baseUrl = LOCAL_LLM_URL, model, messages, maxTokens = 700, temperature = 0.6, timeoutMs = LLM_TIMEOUT_MS }) {
  return provider === 'cloud'
    ? cloudChat({ apiKey, model, messages, maxTokens, temperature, timeoutMs })
    : localChat({ baseUrl, apiKey, model, messages, maxTokens, temperature, timeoutMs });
}

// --- health, for the panel and /status -----------------------------------------
export async function health({ baseUrl = LOCAL_LLM_URL, apiKey = LLM_API_KEY } = {}) {
  const started = Date.now();
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const base = trimUrl(baseUrl);
  try {
    const res = await fetch(`${base}/v1/models`, { headers, ...withTimeout(4000) });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, baseUrl: base, ms, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    const models = (data?.data ?? []).map((m) => m.id).filter(Boolean);
    return { ok: true, baseUrl: base, ms, models };
  } catch (e) {
    return { ok: false, baseUrl: base, ms: Date.now() - started, error: e?.message ?? String(e) };
  }
}
