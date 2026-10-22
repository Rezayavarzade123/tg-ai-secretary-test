import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static checks on the panel's front end. There is no jsdom here, so instead of
// rendering we verify the contract between the wiring in ui.js and the templates
// that produce the elements. This is exactly the class of bug that shipped once:
// a handler wired to #saveQuiet when no such element was ever rendered.

const dir = path.join(process.cwd(), 'bot', 'panel');
const js = fs.readFileSync(path.join(dir, 'ui.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'ui.html'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'ui.css'), 'utf8');
const server = fs.readFileSync(path.join(dir, 'server.mjs'), 'utf8');

const staticIds = [...new Set([...js.matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g)].map((m) => m[1]))];
const toggleIds = [...new Set([...js.matchAll(/bindToggle\('([\w-]+)'/g)].map((m) => m[1]))];
const allIds = [...new Set([...staticIds, ...toggleIds])];

const producedIds = new Set([
  ...[...js.matchAll(/id="\$?\{?([\w-]+)"?\}?"/g)].map((m) => m[1]),
  ...[...js.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]),
  // Elements built by the small helpers take their id from the first argument.
  ...[...js.matchAll(/\b(?:toggle|field)\('([\w-]+)'/g)].map((m) => m[1]),
]);

test('every id the script looks for is actually rendered', () => {
  const missing = allIds.filter((id) => !producedIds.has(id));
  assert.deepEqual(missing, [], `wired but never rendered: ${missing.join(', ')}`);
});

test('the script and the markup agree on tab names', () => {
  const tabsInHtml = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  const block = js.match(/const TITLES = \{([\s\S]*?)\};/)?.[1] ?? '';
  const titlesInJs = [...block.matchAll(/(\w+):/g)].map((m) => m[1]);
  const viewsInJs = [...js.matchAll(/(\w+): view[A-Z]\w+/g)].map((m) => m[1]);
  for (const tab of tabsInHtml) {
    assert.ok(titlesInJs.includes(tab), `tab "${tab}" has no title`);
    assert.ok(viewsInJs.includes(tab), `tab "${tab}" has no view function`);
  }
});

test('every view function is reachable from the router or an embedding view', () => {
  const defs = [...js.matchAll(/function (view[A-Z]\w+)\(/g)];
  const orphaned = defs
    .map((m) => m[1])
    // Count uses outside the definition itself (router table, or ${viewX()} embeds).
    .filter((v) => (js.match(new RegExp(`\\b${v}\\b`, 'g')) || []).length < 2);
  assert.deepEqual(orphaned, [], `views defined but never used: ${orphaned.join(', ')}`);
});

test('the page loads no inline script and no remote asset (the CSP allows neither)', () => {
  assert.ok(!/<script(?![^>]*src=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html), 'inline script would be blocked by CSP');
  assert.ok(!/\son[a-z]+="/i.test(html), 'inline handlers would be blocked by CSP');
  assert.ok(!/(src|href)="https?:/.test(html), 'everything must be served from the panel itself');
  for (const f of ['ui.js', 'ui.css']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} must exist`);
    assert.ok(html.includes(`/${f}`), `${f} must be linked`);
  }
  assert.match(server, /script-src 'self'/, 'the CSP must allow the external script');
  assert.match(server, /frame-ancestors 'none'/);
});

test('every element the panel writes has a style or is a known bare element', () => {
  // A cheap guard against typo'd class names that silently lose their styling.
  const classes = [...new Set([...js.matchAll(/class="([^"$]+)"/g)].flatMap((m) => m[1].split(/\s+/)))].filter(Boolean);
  const defined = new Set([...css.matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1]));
  const bootstrap = new Set(['small', 'mono', 'muted', 'active', 'on', 'show', 'err']);
  const unknown = classes.filter((c) => !defined.has(c) && !bootstrap.has(c));
  assert.deepEqual(unknown, [], `classes used by the UI but not styled: ${unknown.join(', ')}`);
});

test('the session survives a setup that drops cookies', () => {
  // A proxy that strips Set-Cookie would otherwise make a correct token look
  // wrong: the login succeeds, then every request is anonymous again.
  assert.match(js, /sessionStorage\.setItem\(TOKEN_KEY/, 'the token is kept in the tab');
  assert.match(js, /Authorization: `Bearer \$\{token\}`/, 'and sent as a header on every request');
  assert.match(js, /body\.token \|\| token/, 'the login response is what it is kept from');
  assert.match(server, /token: ACCESS_TOKEN/, 'the login route hands the token back');
  assert.match(js, /searchParams\.get\('token'\)/, 'a ?token= link signs the tab in');
  assert.match(js, /history\.replaceState/, 'and the token is taken back out of the address bar');
});

test('the API routes the UI calls exist on the server', () => {
  const calls = [...new Set([...js.matchAll(/api\('(\/api\/[^'`?]+)/g)].map((m) => m[1]))];
  for (const call of calls) {
    // Match the literal, or the regex route shape it belongs to.
    const literal = server.includes(`'${call}`) || server.includes(`\`${call}`);
    const pattern = new RegExp(call.replace(/\/\d+/g, '\\/\\d+').replace(/\//g, '\\/'));
    const routed = /^\/api\/(drafts|contacts|notes)\//.test(call)
      ? /req\.method === '(POST|PUT|DELETE)' && \^\\\/api\\\//.test(server)
      : true;
    assert.ok(literal || routed, `${call} is called by the UI but has no route (${pattern})`);
  }
});
