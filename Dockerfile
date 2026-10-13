# The gateway: API + built SPA in one process.
#
# Multi-stage so the runtime image carries no toolchain. The API is a Node app
# and the SPA is static files, so there is no compiler or package manager in the
# final stage to attack.

# ── Stage 1: install workspace dependencies ───────────────────────────────────
FROM node:24.11.0-bookworm-slim AS deps
WORKDIR /app

# Copy manifests first so the install layer is cached across source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The shared tsconfig is part of the build, not just the manifests. Without it
# here, apps/*/tsconfig.json has an `extends` pointing at a file that does not
# exist in the image and TypeScript silently falls back to its own defaults
# (ES5 target, no strict) — which fails the build with downlevelIteration and
# union-narrowing errors that do not reproduce on the host at all.
COPY tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

RUN corepack enable && pnpm install --frozen-lockfile

# ── Stage 2: build the SPA ────────────────────────────────────────────────────
FROM deps AS web
WORKDIR /app
COPY apps/web ./apps/web
RUN pnpm --filter @ocm/web build

# ── Stage 3: build the API ────────────────────────────────────────────────────
FROM deps AS api
WORKDIR /app
COPY apps/api ./apps/api
RUN pnpm --filter @ocm/api build

# ── Stage 4: runtime ──────────────────────────────────────────────────────────
FROM node:24.11.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=api /app/apps/api/dist ./apps/api/dist
COPY --from=api /app/apps/api/package.json ./apps/api/package.json
# The SPA is served by the API from this path. main.ts resolves it via
# WORKSPACE_ROOT, which the compose file sets to /app.
COPY --from=web /app/apps/web/dist ./apps/web/dist
# The admin CLIs (auth:setup, auth:reset-password, auth:enable-totp,
# auth:check-totp, auth:disable-totp, auth:sessions, project:add).
#
# `src` and `scripts` are both needed: the scripts import from ../src, and they
# are TypeScript run through tsx. Copying only `src` — as this file did — leaves
# the image with no scripts directory at all, so every `docker compose exec
# gateway ... auth:*` fails with ERR_MODULE_NOT_FOUND on the script itself.
# They are now here because the database lives in a named volume, which means
# these commands have to run in the container to reach it.
COPY --from=api /app/apps/api/src ./apps/api/src
COPY --from=api /app/apps/api/scripts ./apps/api/scripts
COPY host ./host
COPY scripts ./scripts

# /app/data is the mount point for the database volume. It has to exist in the
# image, owned by the runtime user, because Docker seeds a fresh named volume
# from the mount point's ownership and permissions. Without this the volume is
# created root-owned and the unprivileged gateway below cannot write auth.db.
RUN mkdir -p /app/data && chown node:node /app/data

# Run unprivileged. The node image already provides this user.
USER node

# 0.0.0.0 inside the container, because Docker's published port is forwarded from
# outside this network namespace: a service bound to the container's own loopback
# is not reachable through `-p`, and connections are reset. Reachability is
# controlled by the host-side mapping ("127.0.0.1:3000:3000" in compose), not by
# this.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/auth/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/src/main.js"]
