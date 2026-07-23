# syntax=docker/dockerfile:1
# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:24-slim AS builder
WORKDIR /app

# Prisma + lightningcss both need openssl on Debian slim
# BuildKit cache: apt packages persist between builds
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update -y && apt-get install -y openssl

# Install dependencies first (cached layer — only re-runs when lockfile changes)
# BuildKit cache: npm download cache persists between builds (~30s → ~5s)
COPY package.json package-lock.json ./
COPY prisma ./prisma/
# scripts/copy-pdfjs-worker.mjs runs from `postinstall`, so it must be on
# disk BEFORE `npm ci`. Only this one script needs to be present pre-install;
# the rest of `scripts/` (backfills, deploy.sh, etc.) lands with the later
# `COPY . .` so cache invalidation stays scoped to lockfile + this one file.
COPY scripts/copy-pdfjs-worker.mjs ./scripts/copy-pdfjs-worker.mjs
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy source and build
COPY . .

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN npx prisma generate
RUN npm run build

# ── Stage 2: Production runtime ───────────────────────────────────────────────
FROM node:24-slim AS runner
WORKDIR /app

# Install openssl and Docker CLI for logs functionality
# BuildKit cache: apt packages persist between builds
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update -y && \
    apt-get install -y openssl curl ca-certificates && \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && \
    chmod a+r /etc/apt/keyrings/docker.asc && \
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update -y && \
    apt-get install -y docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# ── Build identity ────────────────────────────────────────────────────────────
# "What SHA is running?" was previously unanswerable from the running system:
# /api/health reported npm_package_version, which is the same string across
# dozens of deploys, and deploy.sh pinned IMAGE_TAG to the SHA and discarded it.
# CI passes these as build-args; src/lib/build-info.ts reads them back and they
# surface in /api/health, on /admin/infra, and in every alert email footer.
# Defaults keep a local `docker build` honest rather than lying.
ARG GIT_SHA=unknown
ARG BUILT_AT=""
ENV GIT_SHA=$GIT_SHA
ENV BUILT_AT=$BUILT_AT

RUN groupadd --system --gid 1001 nodejs
RUN useradd --system --uid 1001 nextjs
# Allow nextjs user to read the Docker socket (mounted :ro) for docker logs.
# Host docker group is typically GID 999 on Ubuntu/Debian.
# DOCKER_GID build arg allows override if the host GID differs.
ARG DOCKER_GID=988
RUN groupadd --gid $DOCKER_GID docker || true && usermod -aG docker nextjs

# Standalone output + static assets — copied by ALLOWLIST, not wholesale.
# Next ≥16.2's Turbopack file tracer can decide a dynamic fs path (e.g. the
# env-overridable log-archive dir) means "this app reads arbitrary project
# files" and mirror the ENTIRE repo into .next/standalone (src/, e2e/, docs/,
# ~+65 MB; outside Docker it even embeds a local .env). Neither the documented
# turbopackIgnore comment nor outputFileTracingExcludes suppresses it under
# Turbopack (nextjs#95125), so the image copies only the four things a
# standalone server actually consists of — anything else the tracer stuffs in
# can never reach the image, on any Next version.
COPY --from=builder /app/.next/standalone/server.js ./server.js
COPY --from=builder /app/.next/standalone/package.json ./package.json
COPY --from=builder /app/.next/standalone/.next ./.next
COPY --from=builder /app/.next/standalone/node_modules ./node_modules
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Prisma client (needed at runtime for DB queries)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma

# Documentation files — read by the /admin/docs viewer at runtime.
# Each COPY is wrapped in a wildcard form so a missing file (e.g.
# someone deletes CHANGELOG.md) doesn't break the build. Glob expands
# to nothing → no-op rather than ERROR. The runtime walker prunes
# anything it can't surface.
COPY --from=builder /app/CLAUDE.md* ./
COPY --from=builder /app/README.md* ./
COPY --from=builder /app/CHANGELOG.md* ./
COPY --from=builder /app/security_audit_report.md* ./
COPY --from=builder /app/human_user_guide_v3.html* ./
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/infra ./infra

# Create logs and Next.js cache directories writable by nextjs user
RUN mkdir -p /app/logs /app/.next/cache && chown -R nextjs:nodejs /app/logs /app/.next/cache

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Set the NODE_OPTIONS environment variable to increase the memory limit for Node.js
ENV NODE_OPTIONS="--max-old-space-size=2048"
CMD ["node", "server.js"]
