# ── Stage 1: Install dependencies ────────────────────────────────────────────
# Use Debian-based (slim) to match the glibc binaries in package-lock.json.
# Alpine uses musl which conflicts with native binaries like lightningcss.
FROM node:20-slim AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma/

# Use npm install (not npm ci) so npm resolves the correct platform-specific
# native binaries (e.g. lightningcss-linux-x64-gnu) regardless of which OS
# the package-lock.json was generated on (macOS).
RUN npm install

# ── Stage 2: Build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

# Prisma needs openssl at build time on Debian slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN npx prisma generate
RUN npm run build

# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app

# Prisma needs openssl at runtime on Debian slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs
RUN useradd --system --uid 1001 nextjs

# Standalone output + static assets
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Prisma client (needed at runtime for DB queries)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
