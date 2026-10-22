// Kept so older imports (and any custom code you added) keep working.
// The real implementation now lives in lib/llm.js, which supports both a local
// OpenAI-compatible server and Ollama's hosted API.
export { chat, health } from './llm.js';
