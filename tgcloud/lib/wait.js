// Timer support. If the platform runtime has no setTimeout, canSleep is false and
// the bot falls back to answering immediately (see business_message.js).
export const canSleep = typeof setTimeout === 'function';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
