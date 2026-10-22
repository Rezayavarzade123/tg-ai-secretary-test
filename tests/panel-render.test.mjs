import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { startPanel } from '../bot/panel/server.mjs';

// Run the panel's real front end against the real server, in a fake DOM.
//
// There is no browser in this environment, so the next best thing is to execute
// ui.js exactly as a browser would: same script, same fetch calls, same order.
// That catches the failure a static test cannot — an exception while rendering,
// which leaves the login screen up and makes the panel look like it rejected a
// password when in fact the script died.

const dir = path.join(process.cwd(), 'bot', 'panel');
const uiJs = fs.readFileSync(path.join(dir, 'ui.js'), 'utf8');
const uiHtml = fs.readFileSync(path.join(dir, 'ui.html'), 'utf8');

// --- a DOM, small enough to read ---------------------------------------------
function makeDom() {
  const listeners = new Map();
  const elements = new Map();

  const el = (id) => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        id,
        value: '',
        textContent: '',
        innerHTML: '',
        className: '',
        disabled: false,
        checked: false,
        dataset: {},
        style: {},
        classList: {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
          contains: (c) => classes.has(c),
          toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : on ? classes.add(c) : classes.delete(c)),
        },
        addEventListener: (type, fn) => listeners.set(`${id}:${type}`, fn),
        onclick: null,
        focus() {},
        querySelector: () => el(`${id}-child`),
        querySelectorAll: () => [],
        scrollIntoView() {},
      });
    }
    return elements.get(id);
  };

  // Every id the page can possibly have: the static markup plus the ids the
  // templates produce. Anything else is a real "element not found" in a browser.
  const known = new Set([
    ...[...uiHtml.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]),
    ...[...uiJs.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]),
    ...[...uiJs.matchAll(/\bid="\$\{([\w]+)\}"/g)].map((m) => m[1]),
  ]);

  const document = {
    hidden: false,
    activeElement: null,
    title: 'Secretary',
    querySelector(sel) {
      const id = sel.startsWith('#') ? sel.slice(1) : null;
      if (id && !known.has(id)) return null; // what a browser does, and what we want to know
      return el(id || sel);
    },
    querySelectorAll: () => [],
    addEventListener: (type, fn) => listeners.set(`document:${type}`, fn),
  };

  const fetchCalls = [];
  const fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), method: options.method || 'GET', options });
    return realFetch(String(url), options);
  };

  return { document, el, listeners, fetchCalls, fetch, known, elements };
}

let realFetch;

// Boot the real script against a real server, with a fake DOM. Returns everything a
// test needs to ask "did it work", including the errors the script swallowed.
async function boot() {
  const server = await startPanel({ port: 0, host: '127.0.0.1', lanAddress: '127.0.0.1', demo: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  realFetch = (url, options) => fetch(`${origin}${url}`, options);

  const dom = makeDom();
  const errors = [];
  const storage = new Map();

  const context = vm.createContext({
    document: dom.document,
    window: { scrollY: 0, scrollTo() {}, confirm: () => false, addEventListener() {} },
    location: { href: `${origin}/`, pathname: '/', hash: '', searchParams: new URLSearchParams() },
    history: { replaceState() {} },
    sessionStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    fetch: dom.fetch,
    setTimeout: (fn) => { try { fn(); } catch (e) { errors.push(e); } return 0; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    console: { log() {}, warn(...a) { errors.push(new Error(a.join(' '))); }, error(...a) { errors.push(new Error(a.join(' '))); } },
    URL, URLSearchParams, JSON, Math, Date, Number, String, Object, Array, Promise, Error, RegExp, Boolean, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  });

  vm.runInContext(uiJs, context, { filename: 'ui.js' });

  // The boot chain is async and makes real HTTP requests: wait for the render
  // instead of guessing how many ticks it needs.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !dom.el('view').innerHTML) {
    await new Promise((r) => setTimeout(r, 20));
  }

  return { server, dom, context, storage, errors, ping: await (await realFetch('/api/ping')).json() };
}

test('the panel front end boots, signs in and renders the dashboard', async () => {
  const { server, dom, storage, errors, ping } = await boot();
  try {
    assert.deepEqual(errors.map((e) => e.message), [], 'the script must not throw or warn');

    const view = dom.el('view');
    assert.match(view.innerHTML, /Dashboard|draft|Secretary/i, 'the dashboard rendered into #view');
    assert.equal(dom.el('login').classList.contains('show'), false, 'the login screen stays hidden for a demo');
    assert.equal(storage.get('secretary.panel.token'), ping.demoToken, 'the demo token was kept without a login POST');

    const posts = dom.fetchCalls.filter((c) => c.method === 'POST' && c.url.includes('/api/login'));
    assert.equal(posts.length, 0, 'no login request: nothing to drop, nothing to fail');

    const stateCall = dom.fetchCalls.find((c) => c.url.includes('/api/state'));
    assert.ok(stateCall, 'the page asked for state');
    assert.equal(stateCall.options.headers.Authorization, `Bearer ${ping.demoToken}`, 'and sent the token as a header');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('every tab renders against real data without throwing', async () => {
  const { server, dom, context, errors } = await boot();
  try {
    const tabs = vm.runInContext('Object.keys(TITLES)', context);
    assert.ok(tabs.length >= 8, `expected the full navigation, got ${tabs.join(', ')}`);

    for (const tab of tabs) {
      const before = dom.el('view').innerHTML;
      vm.runInContext(`S.tab = ${JSON.stringify(tab)}`, context);
      await vm.runInContext('(async () => { await refresh({ quiet: false }); })()', context);
      await new Promise((r) => setTimeout(r, 60));
      const html = dom.el('view').innerHTML;
      assert.ok(html.length > 200, `the ${tab} tab rendered ${html.length} characters`);
      assert.equal(dom.el('view').innerHTML === before && tab !== 'dashboard', false, `the ${tab} tab replaced the previous view`);
    }

    assert.deepEqual(errors.map((e) => e.message), [], 'no view threw while rendering');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
