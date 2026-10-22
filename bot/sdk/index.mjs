// The local stand-in for the platform's `sdk` module.
//
// Only these three exports are used by the bot: db, api, fetch. Anything the
// handlers import from 'sdk' or 'sdk/db' is resolved here by bot/hooks.mjs, so
// tgcloud/handlers/*.js and tgcloud/lib/*.js run unchanged on this machine.

export { db } from './db.mjs';
export { api, setBotToken, botToken } from './telegram.mjs';

// The platform's fetch wants a pre-serialised body (`fetch.body.json(obj)`).
// Locally we just accept objects too and stringify them.
const localFetch = (url, options = {}) => {
  const opts = { ...options };
  if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof Uint8Array)) {
    opts.body = JSON.stringify(opts.body);
  }
  return globalThis.fetch(url, opts);
};

localFetch.body = {
  json: (obj) => JSON.stringify(obj),
};

export { localFetch as fetch };
