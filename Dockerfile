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

RUN groupadd --system --gid 1001 nodejs
RUN useradd --system --uid 1001 nextjs
# Allow nextjs user to read the Docker socket (mounted :ro) for docker logs.
# Host docker group is typically GID 999 on Ubuntu/Debian.
# DOCKER_GID build arg allows override if the host GID differs.
ARG DOCKER_GID=988
RUN groupadd --gid $DOCKER_GID docker || true && usermod -aG docker nextjs

# Standalone output + static assets
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Prisma client (needed at runtime for DB queries)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma

# Create logs and Next.js cache directories writable by nextjs user
RUN mkdir -p /app/logs /app/.next/cache && chown -R nextjs:nodejs /app/logs /app/.next/cache

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Set the NODE_OPTIONS environment variable to increase the memory limit for Node.js
ENV NODE_OPTIONS="--max-old-space-size=2048"
CMD ["node", "server.js"]
