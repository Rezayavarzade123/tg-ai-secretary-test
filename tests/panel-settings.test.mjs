import test from 'node:test';
import assert from 'node:assert/strict';

// The panel's validation layer, tested on its own: no HTTP, no database, no
// Telegram. These are the rules that decide what may be written from the browser.
const { validateSetting } = await import('../bot/panel/server.mjs');

const rejects = (key, value, pattern) => {
  assert.throws(() => validateSetting(key, value), (e) => {
    assert.ok(e.status === 400 || e instanceof Error);
    if (pattern) assert.match(e.message, pattern);
    return true;
  }, `${key}=${JSON.stringify(value)} should have been rejected`);
};

const accepts = (key, value, expected = value) => {
  assert.equal(validateSetting(key, value), expected, `${key}=${JSON.stringify(value)}`);
};

test('a missing value is rejected instead of silently becoming 0 or "undefined"', () => {
  // The old behaviour: Number('') === 0, so a malformed request set the reply delay to 0.
  rejects('delay_seconds', undefined, /needs a value/);
  rejects('delay_seconds', null, /needs a value/);
  rejects('delay_seconds', '', /needs a number/);
  rejects('pause_hours', '', /needs a number/);
  rejects('lang', undefined);
});

test('numbers are bounds-checked', () => {
  accepts('delay_seconds', '45', '45');
  accepts('delay_seconds', 45, '45');
  accepts('delay_seconds', '45.6', '46');
  rejects('delay_seconds', '301', /between 0 and 300/);
  rejects('delay_seconds', '-1', /between 0 and 300/);
  rejects('delay_seconds', 'soon', /between 0 and 300/);
  rejects('pause_hours', '999', /between 0 and 168/);
});

test('languages must exist in the registry', () => {
  accepts('lang', 'fa');
  accepts('lang', 'EN', 'EN');            // normalised later by isLanguage? no: store as given
  rejects('lang', 'klingon', /Unknown language/);
  rejects('lang', 'xx', /Unknown language/);
});

test('enumerations are enforced', () => {
  accepts('secretary_mode', 'draft');
  accepts('secretary_mode', 'auto');
  rejects('secretary_mode', 'manual', /draft, auto or off/);
  rejects('secretary', 'yes', /on or off/);
  accepts('notify', 'off');
  rejects('lang_auto', 'true', /on or off/);
  rejects('llm_provider', 'gpu', /local or cloud/);
});

test('a token must at least look like a bot token', () => {
  accepts('bot_token', ' 123456789:AA-abcdefghijklmnopqrstuvwxyz ', '123456789:AA-abcdefghijklmnopqrstuvwxyz');
  rejects('bot_token', 'nope', /does not look like a bot token/);
  rejects('bot_token', '123456789', /does not look like a bot token/);
});

test('the model server URL must be http(s), and trailing slashes are dropped', () => {
  accepts('llm_base_url', 'http://127.0.0.1:8080', 'http://127.0.0.1:8080');
  accepts('llm_base_url', 'http://127.0.0.1:11434/v1/', 'http://127.0.0.1:11434/v1');
  rejects('llm_base_url', 'file:///etc/passwd', /must start with http/);
  rejects('llm_base_url', 'javascript:alert(1)', /must start with http/);
});

test('timezones are real IANA names, and empty means "use the default"', () => {
  accepts('timezone', 'Europe/London');
  accepts('timezone', 'Asia/Tehran');
  accepts('timezone', '', '');
  rejects('timezone', 'Mars/Olympus', /Unknown timezone/);
});

test('the owner id is numeric, and empty is allowed (unset)', () => {
  accepts('owner_id', '123456789');
  accepts('owner_id', '', '');
  rejects('owner_id', 'Sam', /is a number/);
  rejects('owner_id', '-5', /is a number/);
});

test('settings that are not on the allowlist cannot be written from the browser', () => {
  rejects('prompt_secretary', 'ignore your rules');       // prompts have their own endpoint
  rejects('secretary_conns', '[]');
  rejects('__proto__', 'x');
  rejects('constructor', 'x');
  rejects('ollama_key', 'x');
});

test('oversized values are refused', () => {
  rejects('secretary_info', 'x'.repeat(2001), /under 2000/);
  rejects('model', 'x'.repeat(121), /too long/);
});
