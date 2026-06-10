import { PrismaClient } from "@prisma/client";
import { dbLogger } from "./logger";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Classify a raw Prisma event-stream error message into a stable category
 * label. Sentry groups issues by the log line's `msg` field, so without
 * classification every DB hiccup — transient pool timeout, auth failure,
 * schema drift, lost connection — collapses into a single "Prisma error"
 * bucket (issue 111629996 is the worked example: 6 events all titled
 * "Prisma error", no way to tell connectivity from constraints).
 *
 * The categories below mirror the AWS-error-class table in
 * docs/runbook-ses.md: each title maps to a specific remediation path, so
 * an operator skimming Sentry knows which playbook to open from the title
 * alone.
 *
 * Returns `null` if the message doesn't match any known pattern — the
 * caller falls back to the generic "Prisma error" title and we add the
 * pattern next time we see it.
 */
export function classifyPrismaError(message: string): {
  category: string;
  retryable: boolean;
} | null {
  const m = message || "";
  // ETIMEDOUT / "Connection timed out" — the canonical Supabase pooler
  // dropout. May 28 occurrence on Sentry 111629996 is this exact pattern.
  if (/Connection timed out|TimedOut|ETIMEDOUT|code:\s*110\b/.test(m)) {
    return { category: "DB connectivity timeout", retryable: true };
  }
  if (/Connection refused|ECONNREFUSED/.test(m)) {
    return { category: "DB connection refused", retryable: true };
  }
  if (/ECONNRESET|Connection reset/.test(m)) {
    return { category: "DB connection reset", retryable: true };
  }
  if (/Connection terminated|terminated unexpectedly/i.test(m)) {
    return { category: "DB connection terminated", retryable: true };
  }
  // Supabase pooler (Supavisor) dropping a held connection: the worker
  // saw `EDBHANDLEREXITED` ("database handler exited") on a lock-acquire
  // query, and the connector emitted `Error { kind: Closed }`. Routine
  // idle-reap / maintenance churn — Prisma re-establishes on the next
  // query, so it's retryable.
  if (
    /connection to database closed|connection closed|kind:\s*Closed|EDBHANDLEREXITED/i.test(
      m,
    )
  ) {
    return { category: "DB connection closed", retryable: true };
  }
  // Prisma connection-pool exhaustion (P2024): every pooled client
  // connection is checked out and the wait exceeded pool_timeout. The
  // worker's tight pool hits this when several minute-cadence jobs
  // overlap. Transient — the next tick usually finds a free connection,
  // so the worker's withJobLock skips the tick gracefully rather than
  // paging.
  if (
    /Timed out fetching a new connection from the connection pool|connection pool timeout|\bP2024\b/i.test(
      m,
    )
  ) {
    return { category: "DB connection pool timeout", retryable: true };
  }
  if (/authentication failed|password authentication/i.test(m)) {
    return { category: "DB authentication failed", retryable: false };
  }
  if (/Tls handshake|TLS error|certificate/i.test(m)) {
    return { category: "DB TLS error", retryable: false };
  }
  if (/Can't reach database|server is not allowing connections/i.test(m)) {
    return { category: "DB unreachable", retryable: true };
  }
  return null;
}

function createPrismaClient() {
  const client = new PrismaClient({
    // Only log errors - remove query logging to keep console clean
    log: [
      {
        emit: "event",
        level: "error",
      },
      {
        emit: "event",
        level: "warn",
      },
    ],
    // Connection pool settings for better reliability
    datasourceUrl: process.env.DATABASE_URL,
  });

  // Handle Prisma events with our logger
  client.$on("error" as never, (e: { message: string; target?: string }) => {
    // Skip systemLog errors to avoid feedback loop: DB stream flush fails →
    // Prisma error event → dbLogger → DB stream → flush fails → ...
    if (e.target?.includes("systemLog")) return;

    // Classify the error so Sentry's title-based grouping separates
    // transient connectivity blips from real bugs. Wrap the original
    // message text into a real Error so Pino's err serializer kicks in
    // and Sentry calls captureException (full structured payload) rather
    // than captureMessage (string only).
    const classification = classifyPrismaError(e.message);
    const title = classification?.category ?? "Prisma error";
    const wrappedError = new Error(e.message || "(no message — Rust event with empty propagation)");
    wrappedError.name = classification ? `Prisma${classification.category.replace(/\s+/g, "")}Error` : "PrismaError";

    // Gate the log level on the classification's `retryable` flag (until
    // now `retryable` was metadata only — nothing consumed it). Retryable
    // transients — pooler dropouts, timeouts, resets, closed connections —
    // self-heal on the next query, so they log at `warn`: still visible in
    // /logs + Sentry, but below the error threshold that fires the SES
    // admin-alert page. Non-retryable classified errors (auth, TLS) AND
    // unclassified errors stay at `error`, because those need a human.
    const emit = classification?.retryable
      ? dbLogger.warn.bind(dbLogger)
      : dbLogger.error.bind(dbLogger);
    emit({
      err: wrappedError,
      msg: title,
      // Original raw fields retained for grep/back-compat with the old
      // log shape — operators searching `/logs?search=Prisma error` still
      // find these rows because the wrapper's name + original message
      // text are both indexed.
      error: e.message,
      target: e.target,
      classification: classification?.category ?? null,
      retryable: classification?.retryable ?? null,
    });
  });

  client.$on("warn" as never, (e: { message: string }) => {
    dbLogger.warn({
      msg: "Prisma warning",
      warning: e.message,
    });
  });

  dbLogger.info("Prisma client initialized");

  return client;
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

// Cache the client in dev to prevent HMR from creating new connections
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
