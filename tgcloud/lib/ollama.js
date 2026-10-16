import { fetch } from 'sdk';
import { OLLAMA_URL } from './config.js';
import { stripThink } from './text.js';

// One non-streaming chat call to Ollama's hosted API.
// Returns the assistant text. Throws a readable Error on failure.
export async function chat({ apiKey, model, messages, maxTokens = 700 }) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fetch.body.json({
      model,
      messages,
      stream: false,
      options: { num_predict: maxTokens, temperature: 0.6 },
    }),
  });

  const raw = await res.text();

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('Ollama rejected the API key (HTTP ' + res.status + '). Send /setkey <new key>.');
    }
    if (res.status === 404) {
      throw new Error(`Ollama doesn't know the model "${model}". Check the name with /model.`);
    }
    if (res.status === 429) {
      throw new Error('Ollama rate/usage limit reached (HTTP 429). Try again later.');
    }
    throw new Error(`Ollama error ${res.status}: ${raw.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('Ollama returned a non-JSON response: ' + raw.slice(0, 200));
  }
  // Reasoning (if any) arrives in message.thinking; we only use the final content.
  return stripThink(data?.message?.content ?? '');
}
