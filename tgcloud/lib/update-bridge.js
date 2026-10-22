// Where the updater meets the handlers.
//
// Updating is the local runtime's job: it needs git, a checkout and the ability to
// restart the process. None of that exists on Telegram Serverless, and `tgcloud/`
// must stay portable (no `node:` imports, no `bot/` imports). So the runner
// registers an implementation here at start-up, and the handlers ask for it. When
// nothing is registered — a serverless deployment — `/update` says so instead of
// pretending.

let implementation = null;

export function setUpdaterImplementation(impl) {
  implementation = impl || null;
}

export function updater() {
  return implementation;
}
