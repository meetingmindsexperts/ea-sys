# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

# Prisma + lightningcss both need openssl on Debian slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Install dependencies first (cached layer — only re-runs when package.json changes)
# Delete lockfile so npm resolves platform-specific native binaries fresh for
# Linux (the lockfile was generated on macOS and records darwin binaries only).
COPY package.json ./
COPY prisma ./prisma/
RUN npm install

# Copy source and build
COPY . .

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN npx prisma generate
RUN npm run build

# ── Stage 2: Production runtime ───────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app

# Install openssl and Docker CLI for logs functionality
RUN apt-get update -y && \
    apt-get install -y openssl curl && \
    # Install Docker CLI
    curl -fsSL https://get.docker.com -o get-docker.sh && \
    sh get-docker.sh && \
    rm get-docker.sh && \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs
RUN useradd --system --uid 1001 nextjs

# Add nextjs user to docker group (GID 999 is common for docker group)
# This allows the nextjs user to execute docker commands
RUN groupadd -g 999 docker || true && usermod -aG docker nextjs

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
# Set the NODE_OPTIONS environment variable to increase the memory limit for Node.js
ENV NODE_OPTIONS="--max-old-space-size=2048"
CMD ["node", "server.js"]
