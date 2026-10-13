# opencode-mobile

A mobile-first web client for [opencode](https://github.com/sst/opencode), the
coding agent. It runs on your own machine, reachable from your phone over a
Cloudflare tunnel, and it talks to a local `opencode serve` process rather than
to a hosted API.

Three things make up the runtime:

| Piece | Where it runs | What it does |
| --- | --- | --- |
| `host/host-supervisor.mjs` | Windows host | Starts and stops one `opencode serve` per project. |
| `opencode serve` | Windows host | The actual agent. Holds your provider credentials. |
| Gateway (API + SPA) | Host or Docker | Auth, the read-only file/diff browser, and the authenticated proxy to `serve`. |

The gateway is the only thing exposed to the network, and it is a login wall in
front of a full coding agent. Treat its bind address as a security decision, not
a convenience setting.

---

## Quick start (native, Windows)

Requires Node 24+, pnpm 10+, and an opencode install.

```bash
git clone <this repo> opencode-mobile
cd opencode-mobile
pnpm install

copy .env.example .env      # PowerShell: Copy-Item .env.example .env
```

Fill in `.env`. At minimum:

```bash
APP_ORIGIN=http://localhost:3000
SERVE_PASSWORD=<generate>
SUPERVISOR_TOKEN=<generate>
```

Generate the two secrets rather than inventing them:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Then create the login account (interactive; asks for a password and a TOTP
secret) and add a project.

Under the Docker deployment, the database is in a volume, so these run in the
container via the wrapper — see [Where the database
lives](#where-the-database-lives-and-why-commands-run-in-the-container):

```powershell
docker compose up -d
.\scripts\auth.ps1 setup
.\scripts\auth.ps1 project-add
```

For a native (non-Docker) install, use `pnpm auth:setup` and `pnpm project:add`
directly, and make sure `.env` has `DEPLOYMENT=native`. Then `pnpm build`.

Run the supervisor and the gateway in two terminals, or install them as
logon tasks (below):

```bash
pnpm supervisor     # terminal 1
pnpm --filter @ocm/api start   # terminal 2
```

Open <http://localhost:3000>.

For UI work, `pnpm dev` runs the API and the Vite dev server together. Add the
Vite origin to `APP_ORIGIN` (`http://127.0.0.1:5173` is already in the example)
and set `SESSION_COOKIE_NAME=ocm_session`, because the `__Host-` cookie prefix
requires HTTPS and Safari will silently drop it over plain HTTP.

---

## Exposing it to your phone

The intended path is a Cloudflare tunnel, which keeps the gateway on loopback
and terminates TLS. Do not port-forward this to the internet.

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

Then set the resulting hostname as your `APP_ORIGIN` and re-login, because the
session cookie is scoped to the origin. Behind cloudflared the API trusts one
proxy hop (`trust proxy`, set in `main.ts`); that is correct only while
cloudflared is the sole thing in front of it.

If you must reach it over the LAN instead, use a non-loopback `APP_ORIGIN` and
read the firewall section below first. `APP_ORIGIN` refuses to start with a
non-loopback `http://` entry on purpose.

---

## Deployment options

### A. Native, with logon tasks (recommended on Windows)

```bash
powershell -ExecutionPolicy Bypass -File scripts/install-autostart.ps1
powershell -ExecutionPolicy Bypass -File scripts/autostart.ps1 -Action Status
```

This registers two current-user scheduled tasks, `ocm-supervisor` and
`ocm-gateway`, and starts them.

These are scheduled tasks and not `sc.exe` services on purpose. The supervisor
spawns `opencode serve`, and opencode reads provider credentials from the *user
profile*. A service running as LocalSystem has a different profile, so every
model call would fail with an auth error that looks like an opencode bug. The
consequences of this choice, stated plainly:

- The app is up only while you are signed in.
- The tasks hold no stored password.
- Task output is appended to `logs/supervisor-task.log` and
  `logs/gateway-task.log`. They are not rotated.

`scripts/autostart.ps1` also takes `-Action Start|Stop|Restart|Status|Uninstall`.

### B. Gateway in Docker, supervisor on the host

```bash
docker compose up -d --build
```

`opencode serve` stays on the Windows host, where your projects and provider
credentials are. The container reaches the host over `host.docker.internal`.

Two things differ from the native setup and are set for you in
`docker-compose.yml`, because both are loopback values on the host and have to
be reversed inside the container:

- `GATEWAY_BIND_HOST=0.0.0.0` inside the container. A service bound to the
  container's own `127.0.0.1` is unreachable through a published port, and every
  request dies with a connection reset.
- `SERVE_HOST=host.docker.internal`, overriding the `127.0.0.1` in `.env`.

The LAN is kept out by the published port mapping `127.0.0.1:3000:3000`, not by
the in-container bind. Changing that mapping to `3000:3000` would publish the
login endpoint, and through the proxy a full coding agent, to your whole
network.

The container runs as the unprivileged `node` user, with `cap_drop: ALL` and
`no-new-privileges`.

### Where the database lives, and why commands run in the container

The account and project allowlist live in the Docker **named volume** `ocm-data`,
mounted at `/app/data`. Logs stay a bind mount at `./logs` so you can read them
directly.

The volume is not incidental. This used to be a Windows bind mount from `./data`,
and it had a real defect: **a long-lived SQLite connection over a Docker Desktop
Windows bind mount does not observe writes made by another process.** A gateway
running when you created an account would keep reporting `setupRequired: true`
indefinitely, and a session revoked by a host command would stay valid until
restart. It was measured, not guessed — a fresh open always saw the new data, so
it was specifically the process holding the handle, and the file's mtime never
changed at all. A named volume is a real Linux filesystem inside the Docker VM,
where that does not happen. The same probe now tracks changes in real time.

The trade-off is that **the host cannot see the database**, so the admin commands
have to run in the container. Use the wrapper:

```powershell
.\scripts\auth.ps1 -List        # show the available commands
.\scripts\auth.ps1 enable-totp  # do the thing
.\scripts\auth.ps1 sessions --all
```

It is a thin wrapper over `docker compose exec` and gives the prompt a TTY, which
the password and code entry need.

Running a host `pnpm auth:...` will **refuse** and tell you the container command.
This is deliberate: the host's `data/auth.db` is not the live database, so a host
`pnpm auth:reset-password` would edit a file the gateway never reads and then
report success — you would believe you had revoked an attacker and you would not
have.

The gateway logs the account it actually loaded at startup:

```
[bootstrap] Signed-in account: Gabe (TOTP on)
```

If that does not match reality, restart and check again:

```bash
docker compose restart gateway
```

### Backing up the database

The database is inside a volume, so it is no longer a file you can copy out of
the repo. To take a backup:

```powershell
docker compose exec -T gateway node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('/app/data/auth.db').exec('VACUUM INTO ''/app/data/backup.db''')"
docker cp opencode-gateway:/app/data/backup.db .\auth-backup.db
```

Restore by copying it back over `/app/data/auth.db` with `docker cp` while the
gateway is stopped (`docker compose stop gateway`).

### C. Both, or a real server

Not supported as shipped. The supervisor depends on a Windows user profile and
on `taskkill.exe`; a Linux deployment needs a different process manager.

---

## Firewall

`opencode serve` and the supervisor bind `0.0.0.0` so the container can reach
them. On the LAN that is two reachable ports, and the supervisor is a
process-spawning endpoint protected only by a bearer token. Block them.

Read-only audit, safe to run without elevation:

```bash
powershell -ExecutionPolicy Bypass -File scripts/firewall-check.ps1
```

It reports one of `closed`, `EXPOSED`, or `UNVERIFIED` per port. `UNVERIFIED`
means it found no matching rule and could not read a default-inbound policy
that applies, so it is declining to guess; treat it as "confirm before you
conclude you are safe". The script exits non-zero if anything is not `closed`.

To actually block them, from an elevated prompt:

```bash
powershell -ExecutionPolicy Bypass -File scripts/firewall-block-lan.ps1
```

Ports: `3000` gateway, `4100` supervisor, `4101`+ per-project `serve`.

---

## Account and session management

The first account is created by `auth:setup`, which is interactive: it
needs a TTY to read a password and print a TOTP enrolment URI. Running it
non-interactively fails on purpose rather than silently accepting a blank
password.

| Command | What it does |
| --- | --- |
| `setup` | Create the first account. Refuses if one exists. |
| `reset-password` | Set a new password, keep TOTP. |
| `check-totp` | Diagnose a code that will not verify. |
| `enable-totp` | Re-enrol TOTP, e.g. after a wrong secret was scanned. |
| `disable-totp` | Turn off TOTP, if it is locking you out. |
| `sessions` | List active web and bot sessions. |
| `project-add` | Add a directory to the allowlist. |

These are `.\scripts\auth.ps1 <name>` under Docker, and
`pnpm auth:<name>` / `pnpm project:add` on a native install. `auth.ps1 -List`
prints the list, and accepts either spelling (`enable-totp` or `auth:enable-totp`).

### If login says `invalid_totp`

The password is accepted and the second factor is what failed. Three different
causes produce that one error, so start by asking which one it is:

```powershell
.\scripts\auth.ps1 check-totp
```

Enter a fresh code from your app. It reports one of:

- **valid right now** — the code was fine but expired before it was submitted.
  Codes live 30 seconds; submit a new one.
- **valid for a device whose clock is Ns behind** — your phone's clock drifted.
  Set Date & time to automatic, then check again. The server's clock is correct.
- **no clock drift explains this** — the authenticator holds a different secret
  than this install, usually from a QR that did not scan cleanly. Re-enrol:

```powershell
.\scripts\auth.ps1 enable-totp
```

`enable-totp` requires the current password, and when a second factor is
already enabled it also requires a working code or an unused recovery code, so
learning the password alone is not enough to swap the authenticator. It confirms
a code from the new secret before committing, then replaces the recovery codes
and revokes every session. The running gateway picks the change up immediately —
no restart needed.

> Enrolment prints the secret as text alongside the QR code. A half-block QR in
> a terminal can be scanned into a *different but plausible-looking* secret with
> no visible error, so prefer entering the printed secret by hand if the scan
> seems to work but codes never do.

Session cookies are opaque, HttpOnly, SameSite=Strict, and stored server-side in
the `ocm-data` volume. Every mutating request is additionally checked against
`APP_ORIGIN` for CSRF. The browser can read files and diffs and approve
permissions; it cannot execute shell commands. Prompts and session replies stay
in the web app, where they are legible.

**Back up the database.** It holds your account, TOTP secret, and session table.
There is no recovery path if you lose it, and recovery codes are only shown once
at enrolment; re-running `setup` will not overwrite an existing account. See
[Backing up the database](#backing-up-the-database) for the `docker cp`
procedure, or just copy `data/auth.db` on a native install.

---

## Telegram notifier (optional)

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID`; leave them blank to
disable it entirely. `TELEGRAM_APP_URL` adds a button back to the web app.

`/start` `/help` `/status` `/projects` `/project <name>`. Permission requests
arrive as inline buttons.

This is a notification and approval channel only. It deliberately cannot submit
prompts or run shell commands, because a chat log is a bad place to review a
command you are about to authorise. Messages from any user id other than
`TELEGRAM_ALLOWED_USER_ID` are rejected before command handling, and gateway
startup is never blocked on Telegram being reachable.

---

## Development

```bash
pnpm dev          # API + web, with reload
pnpm typecheck    # both packages
pnpm test         # API test suite
pnpm build        # production SPA + API
```

API tests cover auth, TOTP, sessions, the origin/CSRF guard, cookie
configuration, the rate limiter, notifier formatting, the gateway proxy
against a real upstream, and the SSE hub's fan-out, backoff, and
single-upstream-connection guarantees.

### Layout

```
apps/api/        NestJS: auth, gateway proxy, SSE hub, notifier, rate limiting
apps/web/        Svelte 5 SPA
host/            Windows supervisor for `opencode serve`
scripts/         Autostart, firewall, and the auth.ps1 CLI wrapper
data/            Native-install database only. Under Docker the live copy is in
                 the ocm-data volume, and the host CLI refuses to touch this one.
logs/            Task logs
```

### Notes for anyone modifying the proxy

`ServeProxy` forwards `req.rawBody`, not `req.body`, and restores
`content-length`. Nest's body parser consumes the request stream before the
proxy sees it, so forwarding the parsed object silently truncates POST/PATCH
bodies to nothing. `rawBody: true` in `main.ts` is what makes this work; the
regression tests in `test/http.spec.ts` exist to keep it that way.

### Notes for anyone modifying the event stream

`/event` is the one route `ServeProxy` does **not** proxy directly. It
subscribes to `EventHub` (`src/gateway/event-hub.ts`), which holds at most one
upstream `serve` event connection per project and fans it out to every
subscriber in-process. A request that opened its own upstream connection would
make N browser tabs mean N upstream streams, and would leave the notifier on a
second, private one.

The rules that are easy to break by accident:

- **The hub's upstream connection is the only one.** Anything that needs events
  subscribes; it does not dial `serve` itself.
- **`ensureStarted()` is advisory.** If the supervisor refuses or throws, the
  hub logs it and dials anyway, because the data-plane connection is the source
  of truth.
- **A `serve` restart is not special-cased.** It closes the upstream socket and
  ordinary backoff reconnects. Adding a supervisor-driven reconnect would be a
  second, competing path for the same failure.
- **Browser cookies and `Authorization` never reach `serve`.** The hub
  authenticates upstream with Basic `SERVE_PASSWORD` on its own.
- **Cold start still returns 503.** `waitForOpen()` is bounded at 5s, so an
  unreachable `serve` produces the same actionable `serve_unavailable` response
  the proxy used to return, not a hung connection.

Internal subscribers (the notifier) must not be flushed when the hub gives up
after sustained failures; only browser responses are ended, so their existing
`EventSource` reconnect does the recovery.

### A note on process handling

Never spawn `opencode.cmd` with `shell:false`. Node 18.20+ refuses to launch a
`.cmd` file that way (`EINVAL`). Use the real `opencode.exe` binary, or leave
`OPENCODE_BIN` blank so the supervisor resolves it via `npm root -g`.

Never stop opencode by image name. `Get-Process opencode | Stop-Process` will
also kill an interactive opencode TUI in any terminal you have open, which has
nothing to do with this app.
