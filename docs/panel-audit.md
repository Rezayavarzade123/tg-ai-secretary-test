# Control panel — bug audit

Reviewed 2026-10-22 against `bot/panel/*` (server, UI) and the parts of the bot it
touches. Every item below was reproduced before it was fixed, and the fixes are
covered by tests: **52 unit tests** (`npm test`) and **20 end-to-end checks**
(`npm run selftest`, which drives the real handlers with a fake Telegram and a fake
model).

Severity: **H** = lost data, broke a working bot, or exposed control; **M** = wrong
or misleading behaviour, or a real hardening gap; **L** = polish/accessibility.

| # | Sev | Bug | What actually happened | Fix |
|---|---|---|---|---|
| 1 | H | A rejected bot token was saved and reported as success | `bot_token` was written, `onTokenChange` was called, Telegram said 401, and the panel answered `{"ok":true}`. A working bot silently stopped polling and retried forever with a dead token. | The token is verified with `getMe` **before** it is stored. On failure: `400 Telegram rejected that token: …`, the previous token keeps working. Verified live and in `selftest`. |
| 2 | H | Multi-field saves were not atomic | `{"delay_seconds":"37","lang":"klingon"}` returned `400`, but the delay was already saved — the page said "error" while half the change applied. | Two phases: validate every field, then write. Confirmed the valid half is no longer applied (`selftest`). |
| 3 | H | Editing a draft that had already been sent rewrote history | `PUT /api/drafts/:id` accepted any status, so the stored `answer` became text that never reached the person, diverging from `sentText`. | Non-pending drafts are `409`; `updateDraftText()` enforces it for every caller. |
| 4 | H | The panel token leaked into the page | `/api/state` returned `panelUrl` **including `?token=…`**, and Setup rendered it as the panel "address". A screenshot or a copied field handed over full control. | The state carries only the public URL; the token lives in the console banner and `bot/state/panel-token`. Asserted: the token string never appears in any API response. |
| 5 | H | The 5-second refresh destroyed unsaved work | It replaced the whole view. A half-written draft, an edited prompt, the "Show default" text, the model-test answer and the scroll position were all wiped if you had clicked elsewhere. | A `dirty` flag set by any input/change blocks the refresh; the render restores scroll; the test result lives in state so it survives. |
| 6 | H | Panel actions left the Telegram card lying | Sending from the browser updated the database but not the card, which still offered ✅/🔁/🚫. Pressing Regenerate on it then failed ("already sent"). | Every action (`send`/`ignore`/`regen`/edit) now re-renders the card from the database in `drafts.js`, so both front doors agree. Tested. |
| 7 | H | Two processes on one state directory silently clobbered each other | The store rewrites the whole JSON file, so a second writer resurrected its own older copy. This happened for real during the audit: a stopping instance overwrote freshly seeded data (including a bogus token I had just removed). | A lock file (`bot/state/bot.lock`) refuses a second instance with a clear message; saves detect an external modification and the dashboard warns about it. |
| 8 | M | A malformed request turned the reply delay off | `{"key":"delay_seconds"}` (no value) → `Number('') === 0` → stored `0`, silently disabling the delay. | Missing/empty/non-numeric values are `400`. |
| 9 | M | Missing and resolved drafts returned 500 | `send`/`ignore`/`regen` on a missing draft produced a 500 and an error log line; on a resolved draft, 500 too. | `404` and `409` respectively; 5xx is now reserved for genuine failures. |
| 10 | M | No HTTP security headers | The panel could be framed by another page (clickjacking), MIME-sniffed, and the `?token=` URL leaked through `Referer`. | `Content-Security-Policy` (incl. `frame-ancestors 'none'`, `script-src 'self'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, COOP. The UI moved to `ui.css`/`ui.js` so no inline script is needed. |
| 11 | M | Login had no brute-force protection | Unlimited guesses against the single shared token. | 8 failures per minute per IP → 5-minute lockout (`429`). *The first version of this fix was itself broken* — the failure counter was reset on every request, so the limit could never be reached; the new test caught it. |
| 12 | M | Cross-origin writes were accepted | Any page on the LAN could POST settings (SameSite=Strict blocked the cookie, but the token-in-URL and `Authorization` paths were not checks in themselves). | Writes with a foreign `Origin` are `403`. Requests without an `Origin` (curl, scripts) still work. |
| 13 | M | Notes created in the panel had no timestamp | The UI showed "never" for every note added from the browser. | `created` is written with the note. |
| 14 | M | Memory looked almost full on Linux | Used = `total − os.freemem()`, which counts reclaimable page cache as used. On a box that has just loaded a model this reads ~95%. | `MemAvailable` from `/proc/meminfo`; the panel shows "used" and the honest total. |
| 15 | M | The panel hammered the model server | Every 5-second poll ran a fresh `/v1/models` probe — ~12 requests/minute, forever, on a one-slot CPU. | 3-second cache, invalidated when the URL or key changes. |
| 16 | M | Owner id and timezone could never be cleared | Empty fields were skipped when building the patch, so "unset" was impossible from the UI. | Owner and timezone are always sent (empty = unset); only the masked token field means "leave as is". |
| 17 | M | Raw connection ids were shipped to the browser | `secretary_conns` (Business-connection ids that can post as your account) were in `/api/state`. | Only a count is exposed. |
| 18 | M | No way to sign out | The cookie lasts a year. | "Sign out of the panel" in Setup + `POST /api/logout`. |
| 19 | L | Prototype-key hazard | Settings were copied into a plain object; a `__proto__` key would have touched the prototype rather than a property. | Null-prototype copy, and unknown keys are refused by the allowlist. |
| 20 | M | A failed send was reported as "you did something wrong" | A dead business connection or an unreachable Telegram came back as `400`, which reads like a form error. | Upstream failures are `502` with Telegram's own message; the draft stays pending so nothing is lost. |
| 21 | L | The panel was hard to use without a mouse | Switches were `<div>`s (no focus, no role, no state), segment buttons had no `aria-pressed`, no visible focus ring, unlabelled inputs. | `<button role="switch" aria-checked>`, `aria-pressed`, `focus-visible` rings, `aria-label`s, `role="alert"`/`status` for the login error and the toast. |

## Not fixed — accepted and documented

These are design limits rather than defects; they matter if the panel leaves your flat.

- **Plain HTTP.** The token and all traffic are unencrypted on the LAN, and the token
  travels in the URL once. If that matters: `PANEL_HOST=127.0.0.1` and reach it over
  an SSH tunnel (`ssh -L 8787:127.0.0.1:8787 ps4`), or put a TLS reverse proxy in front.
- **One shared token, no accounts.** There is no second user, no 2FA, and no per-action
  audit trail beyond `activity`.
- **No rate limits on model actions.** `/api/test-model` and `/api/drafts/:id/regen`
  are unlimited for an authenticated caller; a stuck button can queue slow generations.
  They are serialised, so it degrades to "slow", not "crash".
- **`/healthz` is unauthenticated.** It reveals only that something is listening; it
  exists so systemd or a phone can check liveness.
- **50 drafts per filter**, no pagination.
- **The login overlay does not trap focus or close on Escape.**
- **The panel is a control surface for an account that can send messages as you.**
  Never port-forward it, and prefer `PANEL_HOST=127.0.0.1` if the machine is shared.

## How to re-run the checks

```bash
npm test                        # 52 unit tests (settings validation included)
npm run selftest                # 20 end-to-end checks incl. panel API, headers, atomicity, throttle
BOT_STATE_DIR=./bot/state-demo PANEL_TOKEN=demo npm start
```

Live smoke test (what the audit used):

```bash
T="Authorization: Bearer demo"; B=http://127.0.0.1:8787
curl -s -D - -o /dev/null -H "$T" $B/ | grep -iE 'content-security|x-frame|nosniff|referrer'
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "$T" -H 'Content-Type: application/json' \
     -d '{"settings":{"delay_seconds":"37","lang":"klingon"}}' $B/api/settings     # 400, delay unchanged
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "$T" -H 'Content-Type: application/json' \
     -H 'Origin: http://evil.example' -d '{"settings":{"lang":"en"}}' $B/api/settings  # 403
curl -s -H "$T" $B/api/state | grep -c 'token='                                   # 0
```
