# PLAN

Current state, what is deliberately unfinished, and the order in which the
remaining work should be done.

## Status

Core application is complete and verified:

- Account setup, TOTP, opaque server-side sessions, CSRF origin guard, login
  rate limiting, session revocation.
- Authenticated proxy to `opencode serve` over SSE, with a working Windows
  supervisor that starts and stops per-project `serve` instances.
- Svelte 5 SPA: sessions, live events, read-only files and diffs, permission
  approval.
- Telegram notifier with allowlisted user, permission buttons, live status.
- Native logon-task deployment and Docker gateway image.

Last full verification: 188 API tests and 75 web tests passing, both packages
typecheck, web production build succeeds, Docker image builds and serves the SPA
and API. Verified against the shipped container build, not just the host tree.

The web count is 75: the request-shape and component tests added with the
CLI-parity work (model picker, Plan/Build toggle, progress bar, streamed
reasoning, todo checklist, turn footer, blocking question prompt) plus the
SessionView suites pinned since — stream lifecycle and disconnect/refetch, the
revert tail, and the long-press composer actions. The SessionView handlers were
the last thing in this document verified only by hand; that list is now empty
(see the resolved items under Remaining work).

Five of the web tests exist because the tests failed first:

- `session.status` was never handled, so `busy` came only from `message.updated`
  and a turn that produced no message showed no activity at all.
- The pending-part renderer matched only `text`, so thinking tokens were dropped
  for the whole turn.
- The model and agent routes were wrong. opencode answers unknown paths with its
  SPA `index.html` and HTTP **200**, not a 404, so `/model` and
  `/session/:id/model` returned HTML that `JSON.parse` rejected with
  "Unexpected token '<'". The real routes are `/api/model` and
  `/api/session/:id/{model,agent}`, verified live. `request()` now detects the
  HTML fallback and names the path, because a mistyped endpoint that looks like a
  success is otherwise very expensive to diagnose.

### The API suite is hermetic

`loadDotEnv` returns early under Vitest, so a developer's real `.env` — live
credentials and deployment choices — can no longer leak into a test run. It used
to: a real Telegram bot token in `.env` enabled the notifier inside the tests,
which subscribed to the event hub (a subscriber no test had asked for), dialled
Telegram over the network, and hung app teardown with a stale connection. The
guard is in `loadDotEnv` rather than in any one test, so the whole suite is
covered and a future test cannot forget it.

### Blocking decision requests

opencode stops a turn until the user answers a question or approves a tool
action. Both are now answered from the app rather than only from a terminal; a
missed request leaves the session stalled with the progress bar still spinning
and nothing on screen saying why.

Questions render inline above the composer, as in the CLI, because they are a
normal part of the conversation — the transcript stays readable and the composer
stays usable while one is open. Permissions keep the existing modal, since they
are an interruption rather than part of the exchange.

The pending list is re-read from `/api/session/:id/question` on entry and on
every question event rather than accumulated from the event payloads. Both the
v1 (`question.asked`) and v2 (`question.v2.asked`) names are handled and both
payloads are ignored, because the two have different shapes and the endpoint is
the authority on what is still pending.

Answers are positional: one array per question, in the order asked. A missing or
reordered entry would answer a different question than the one the user was
shown, so the send button stays disabled until every question has an answer. A
`custom` answer rides in the same array as the chosen labels, since the wire
format has no separate field for free text.

`serveApi.permissions()` had the same route bug as the model picker and was
silently returning the SPA page: `/session/:id/permission` is not a route at all,
as v1 only has the plural `/session/:id/permissions/{id}` reply. The list now
uses `/api/session/:id/permission` with the `{ data }` envelope; the reply stays
on the v1 route because that is the one that exists and answers with a body.

`apps/web` gained a vitest runner for this. It had none, which is how a set of
wire-shape bugs shipped with every layer reporting healthy: the gateway proxied
correct JSON, upstream produced it, and the client discarded it silently. There
was no error to notice, because dropping an event is not an exception. See item 8.

## Known open items

### 1. Docker compose end-to-end run — done

Resolved. The daemon recovered, and `docker compose up -d --build` now runs
clean. Confirmed against the real deployment, not a bare `docker run`: container
healthy, SPA and API both HTTP 200, published on `127.0.0.1:3000` only, running
as the unprivileged `node` user, and `host.docker.internal:4101` reachable
in-container with the bearer token returning 200 and returning 401 without it.

Two of those checks matter for security, so they are the ones to re-run after
touching compose or the supervisor: an unauthenticated proxy hop must fail, and
the port must not be reachable off-loopback.

### 2. Gateway-level SSE fan-out — IMPLEMENTED

The old shape was N upstream connections: `ServeProxy` opened one `serve`
`/event` stream per browser request, and `EventPump` held a second, private one.
N tabs meant N connections, and a gateway restart disconnected all of them
upstream at once.

`EventHub` (`apps/api/src/gateway/event-hub.ts`) now holds at most one upstream
stream per project and fans it out in-process:

- **Ref-counted subscribers.** A project's upstream connection opens on the
  first subscriber and closes after a 30s idle grace period, so a closed tab
  does not kill the stream for the tabs still open.
- **Bounded exponential backoff**, 1s to 30s. A browser that reconnects during
  a retry window is not made to wait out the full backoff.
- **Sustained-failure flush.** After 5 consecutive failed attempts the hub
  ends browser responses cleanly rather than leaving them hanging; the existing
  `EventSource` reconnect then re-establishes and refetches REST state.
  Internal subscribers (the notifier) are never flushed, only paused.
- **`waitForOpen()` with a 5s bound**, so a cold start with `serve` unreachable
  still returns the actionable 503 `serve_unavailable` response. Cold-start
  behaviour is unchanged.
- **Slow-client dropping** at 1MB of buffered data, so one stalled browser
  cannot back up the shared stream for everyone else.
- **Upstream credentials stay upstream.** The hub authenticates to `serve` with
  Basic `SERVE_PASSWORD`; browser cookies and browser `Authorization` headers
  never reach `serve`.

Two decisions worth not undoing:

- **`ensureStarted()` is advisory, not authoritative.** If the supervisor refuses
  or throws, the hub logs it and dials anyway. The data-plane connection is the
  source of truth, and the supervisor being temporarily unavailable must not
  take the event stream down with it.
- **Supervisor restarts deliberately do not reach the hub.** A `serve` restart
  closes the upstream socket, and the hub's ordinary backoff-and-reconnect
  handles it. Wiring supervisor notifications into the hub would have been a
  second, competing reconnect path for the same failure.

`SERVE_HOST` moved into `AppConfig.serve.host` so the hub, the proxy, and the
pump cannot disagree about which host `serve` is on.

A late subscriber is safe because a fresh upstream stream sends no state
snapshot — it sends only `server.connected` with empty properties, and the
browser already refetches state over REST. Verified against a live `serve`
rather than assumed.

The notifier still has its own independent lifecycle; it simply shares the
upstream connection instead of opening a private one.

**Directory-scoped upstream dial (drift since ~1.18.33).** opencode filters
`/event` subscribers by the `directory` query, which the shipped 1.18.32 spec
does not document. A bare dial answers 200 and then delivers nothing but
heartbeats — verified live against 1.18.35: bare stream 4 frames, directory-
scoped stream 501, for the same turn. Both user-reported symptoms traced to
this one starvation: no realtime streaming (refresh masked it by refetching the
transcript over REST) and question cards that never rendered (the question flow
is event-driven, so it starved first). The hub dial carries the project path
(`event-hub.ts`), and `test/event-hub.spec.ts` pins the dialled URL so an
opencode upgrade cannot silently starve the stream again.

The same filter cut the other way, and it is load-bearing: the session list is
directory-filtered too, so the proxy must NOT stamp the project path onto
forwarded queries — verified live, 27 sessions on a bare request versus 3 with
the project directory, all answering 200. Only the hub's `/event` dial (and any
request the browser scopes itself) carries a `directory`.

### 3. SQLite on a Windows bind mount went stale — FIXED, root cause measured

**Symptom.** A container gateway started at 13:19 kept answering
`setupRequired: true` after `pnpm auth:setup` committed the account at 13:45,
while a *fresh* process in the same container read the same file correctly.

**Measured, not assumed.** A throwaway SQLite file in the bind-mounted data dir,
one process holding it open while another committed to it:

| | WAL | DELETE (rollback journal) |
| --- | --- | --- |
| long-lived handle saw | 2 rows, frozen | 2 rows, frozen |
| other process committed | 4 rows | 4 rows |
| `auth.db` mtime during the run | **never changed** | **never changed** |
| fresh open afterwards | 4 rows | 4 rows |

Two things this rules out, both of which had been reasonable guesses:

- **It is not WAL.** The database is in WAL mode with `-shm`/`-wal` sidecars,
  and WAL over a bind mount is a known-bad combination, but DELETE mode fails
  identically. WAL was never the cause.
- **It is not a caching or metadata problem.** `auth.db`'s mtime was
  byte-for-byte static while its contents changed underneath. Nothing was
  cached; the connection simply never noticed.

The actual defect is narrow: **a long-lived SQLite handle over a Docker Desktop
Windows bind mount does not observe external writes to the file.** A fresh open
sees them correctly, in both directions. Only the process that holds the handle
is wrong, which is exactly the gateway.

**Why the stat-and-reopen workaround was rejected.** It cannot work here. It
triggers on a metadata change, and there is no metadata change to observe. It
would have sat in the authentication path looking installed while never firing
once — a silent failure in the worst possible place. Anyone who reads the mtime
evidence above should not go looking for that workaround again.

**Fix: named volume.** `/app/data` is now the `ocm-data` volume, a real Linux
filesystem inside the Docker VM where SQLite's locking and change detection
behave normally. Re-verified with the same probe after the change: the
long-lived handle tracked 1 → 2 → 3 in real time, where before it froze.

Costs accepted, all of them handled:

- The host can no longer see the database, so the admin CLIs run in the
  container. `scripts/auth.ps1` wraps the `docker compose exec` so the operator
  types `.\scripts\auth.ps1 enable-totp` and not a 60-character command.
- **A host-side CLI would have edited a dead file and reported success**, which
  for `auth:reset-password` means believing you revoked an attacker when you did
  not. `resolveDbPath` now refuses when `DEPLOYMENT=docker` and the process is
  not in a container, and prints the command to run instead. The guard lives in
  `resolveDbPath` rather than in each script so a new CLI cannot forget it.
- Backups are a `docker cp` instead of a file copy. See README.
- `./logs` stays a bind mount on purpose: it is written by the container and read
  fresh by the host, which this bug does not affect, and having logs on the host
  is worth more than the tidiness of one consistent rule.

**Two bugs found while doing this, both pre-existing:**

- The Dockerfile copied `src` and `dist` but **not `scripts/`**, so every
  `docker compose exec gateway ... auth:*` failed with `ERR_MODULE_NOT_FOUND`.
  In-container admin commands had never worked; the comment claiming they were
  used in the container was simply wrong.
- Docker creates a named volume root-owned, and the gateway runs as `node`, so a
  fresh volume would have been unwritable. The Dockerfile now creates
  `/app/data` owned by `node`, and Docker seeds a fresh volume from the mount
  point's ownership. A fresh clone now works with no manual `chown`.

### 4. External verification still blocked

| Item | Needs |
| --- | --- |
| Telegram polling | Credentials exist in `.env`, but an end-to-end permission approval has not been exercised since |
| Provider-backed `prompt_async` | A working provider key/model in the host profile |
| LAN isolation | Another machine on the network, or an elevated `firewall-block-lan.ps1` |
| Production tunnel | `APP_ORIGIN` names a hostname; a full login through the tunnel is unverified |

`prompt_async` currently returns upstream `UnknownError` identically when called
directly and through the gateway, which is how we know it is the provider
configuration and not the proxy. Body forwarding is separately proven: a
permission request with a bogus id returns the upstream `PermissionNotFoundError`
rather than a gateway error.

`auth:setup` was unusable until the prompt reader was rewritten: it read the
password with `for await (const chunk of stdin)`, which consumes the stream's
async iterator, so the second prompt (confirm) died with
`AbortError: The operation was aborted`. Now driven by `data` events with
per-prompt listener attach/detach, covered by `test/prompt.spec.ts`. First-run
setup and TOTP enrolment have since been confirmed working interactively.

### 5. TOTP verification had no clock-drift tolerance at all

Found while diagnosing a real `invalid_totp` login. `totp.ts` declared
`WINDOW = 1` and documented it as accepting ±30s of clock drift, but never
passed it to otplib, so `authenticator.check` ran with the library default of
**0**. A code was rejected the instant its 30-second step rolled over, and any
phone with ordinary clock drift could never log in. Login reports all three
causes — expired code, drifted clock, wrong secret — as the same
`invalid_totp`, so the user's credentials being correct was not diagnosable
from the outside.

The window is now applied to a single explicit authenticator instance with
`digits` and `step` pinned too, so no future library default change can
silently alter what users enrolled. Added:

- `diagnoseTotp()` returning `valid | drift(seconds) | unknown`, so "fix your
  phone's clock" is never confused with "re-enrol your secret".
- `pnpm auth:check-totp`, a local read-only diagnostic.
- `pnpm auth:enable-totp`. This filled a real gap: `auth:setup` refuses to run
  once an account exists, so a stale enrolment previously had no repair path at
  all except burning the ten recovery codes. It is gated on the password plus a
  working second factor when one is enabled.
- `enableTotpFromCli()` now returns the new recovery codes. They are hashed on
  the way in, so before this change re-enrolling destroyed the old codes and
  issued no replacement.

`test/totp.spec.ts` checks drift against an independent RFC 6238 implementation
rather than otplib, so the test cannot pass by agreeing with the library's own
mistake. One test asserts the drifting code is rejected by default otplib and
accepted by `verifyTotp`, which fails if the window is ever dropped again.

## Deliberate design decisions

Do not "fix" these without understanding why they are the way they are.

- **Scheduled tasks, not Windows services.** The supervisor spawns
  `opencode serve`, which resolves provider credentials from the user profile.
  LocalSystem has a different profile, so every model call would fail. Cost: the
  app is up only while the user is signed in.
- **`0.0.0.0` inside the container, loopback on the host.** Both values are
  correct at their own layer. A container service bound to its own `127.0.0.1`
  is unreachable through a published port, and connections are reset.
- **`SERVE_HOST` is overridden in compose.** `.env` is the native config where
  `127.0.0.1` is right. `env_file` would pass that same value to the container,
  where it points at the container itself and every proxy request fails with a
  connection refused that reads as a broken supervisor.
- **Proxy forwards `req.rawBody`.** Nest's parser consumes the stream first;
  forwarding the parsed body truncates POST/PATCH to nothing. `rawBody: true`
  in `main.ts` is load-bearing.
- **Telegram cannot submit prompts.** Approval and notification only. A chat
  transcript is a poor place to review a command you are about to authorise.
- **`APP_ORIGIN` rejects non-loopback `http://`.** Refusing to start is better
  than letting a session cookie go out in cleartext and be discovered in review.
- **`UNVERIFIED` in the firewall audit is not "safe".** It means no rule matched
  and no default-inbound policy could be read, so the script declines to guess
  and exits non-zero.
- **A TOTP window of 1 is not a weaker second factor in practice.** It widens
  the live search space from 10^6 to 3x10^6 codes, which is irrelevant next to
  the attempt limiter (8 tries per 15 minutes). Zero tolerance is not a
  security property, it is just unusable.
- **Never write JSON with PowerShell 5.1 `Set-Content -Encoding utf8`.** It
  emits a BOM, and PostCSS's JSON loader then fails with
  `Unexpected token '﻿'`, taking down the web typecheck and build. Use `node`
  and `JSON.stringify`, or `[System.IO.File]::WriteAllBytes` when stripping a
  BOM that is already there.
- **The database is in a named volume, so admin commands run in the container.**
  Not a preference: a host-side `auth:reset-password` would edit a file the
  gateway never reads and report success, which is the one failure mode a
  break-glass command must not have. The guard is `DEPLOYMENT=docker` plus an
  `/.dockerenv` check, deliberately not a platform check, because a native
  Windows install is a legitimate deployment.
- **`scripts/auth.ps1` exists to shorten one command.** The container has no
  pnpm, so the real invocation is
  `docker compose exec gateway npm --prefix apps/api run auth:setup`. That is
  too long to type correctly while an operator is locked out of their own
  account, which is exactly when it gets typed wrong.
- **`cap_drop: ALL` means root in the container is not really root.** It has no
  `CAP_DAC_OVERRIDE`, so `docker exec -u root` still cannot delete a file it does
  not own. Use `-u node` for anything inside a volume. This bit during cleanup.
- **Logs stay a bind mount while data is a volume.** The staleness bug only
  affected a process *holding a handle*, and the host reads each log fresh.
  Consistency is worth less than having the logs where you can read them.

- **The API test suite never reads `.env`.** `loadDotEnv` returns early when
  `VITEST=true`, so a machine's live credentials (Telegram token, supervisor
  token) and deployment choices (rate limits, SSE tuning) cannot change what a
  test asserts. Before the guard, a real token in `.env` enabled the notifier
  inside the run: it subscribed to the event hub, dialled Telegram, and left a
  connection that hung `app.close()`. `NODE_ENV=test` is deliberately not the
  marker, because a production process could legitimately carry it; Vitest's own
  variable cannot appear in production by accident.

- **A client that silently discards a correct payload looks exactly like a broken
  server.** Four shipped bugs shared this shape, and each was diagnosed wrong at
  least once: a stale bundle, a missing `type="submit"`, a stale session cookie,
  and an invalid cookie signature. All four were inferred from source or minified
  output; all four were false. What actually settled each one was the live wire
  data — a response body, or a pasted SSE frame. Reach for the payload before
  theorising about the code that produced it.

## Remaining work, in order

1. Enable the firewall block rules from an elevated prompt, then re-run
   `firewall-check.ps1` and confirm it reports `closed`.
2. Set a real `APP_ORIGIN` and smoke test through the tunnel.
3. Enable the Telegram notifier and verify permission approval end to end.

Done since the last revision:

- **Pinned `SessionView`'s event handlers with component tests.** `api.test.ts`
  covers the wire shapes; the handlers that consume them are now covered by
  `SessionView.test.ts` — stream lifecycle and disconnect/refetch, the revert
  tail, and the long-press composer actions — so a `delta`/`text`-style mix-up
  fails on its own instead of being caught by hand.
- **Made the API test suite hermetic.** It no longer reads the developer's
  `.env`, so a real Telegram token or a machine-specific setting cannot alter
  what the tests assert or dial a network service mid-run.
