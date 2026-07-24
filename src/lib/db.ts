import { PrismaClient, Prisma } from "@prisma/client";
import { dbLogger } from "./logger";
import { enterTenantTx, getTenantOrgId, getTenantStore } from "./tenant-context";

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
  // `/i` + bare `econnrefused` so the lowercase Elixir-tuple form Supabase's
  // Supavisor pooler emits — `FATAL: Failed to connect to database: {:error,
  // :econnrefused}` (the 2026-07-23 19:02 Dubai blip) — is matched, not just
  // Node's uppercase ECONNREFUSED.
  if (/Connection refused|ECONNREFUSED/i.test(m)) {
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
    /connection to database closed|connection closed|closed the connection|kind:\s*Closed|EDBHANDLEREXITED/i.test(
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
  // NOTE: match TLS-specific phrases only. A bare /certificate/i also matches
  // our own model names (`prisma.issuedCertificate.create()`,
  // `certificateTemplateId`), which filed every cert unique-constraint
  // violation under "DB TLS error".
  if (
    /Tls handshake|TLS error|SSL error|self[- ]signed certificate|certificate verif|certificate has expired|unable to get local issuer certificate/i.test(
      m,
    )
  ) {
    return { category: "DB TLS error", retryable: false };
  }
  if (
    /Can't reach database|server is not allowing connections|Failed to connect to database/i.test(
      m,
    )
  ) {
    return { category: "DB unreachable", retryable: true };
  }
  // Constraint violations are application-level, not connectivity. They get
  // their own Sentry bucket so a duplicate-insert never masquerades as an
  // infrastructure problem. Not retryable — retrying re-violates.
  if (/Unique constraint failed|\bP2002\b/i.test(m)) {
    return { category: "DB unique constraint violation", retryable: false };
  }
  if (/Foreign key constraint (failed|violated)|\bP2003\b/i.test(m)) {
    return { category: "DB foreign key constraint violation", retryable: false };
  }
  return null;
}

// One-summarized-alert-per-outage (option c, 2026-07-24). A Supabase
// connectivity blip is now retryable → logs at warn (no per-error page, and the
// old error→alert→alertState-query-fails→error feedback loop is broken). But the
// operator should still be told ONCE. The set below is the genuine
// connection-to-DB outage categories; "DB connection pool timeout" (P2024) is
// deliberately EXCLUDED — that's an app-capacity signal the worker self-heals by
// skipping the tick, not a Supabase outage worth paging for.
const CONNECTIVITY_OUTAGE_CATEGORIES = new Set([
  "DB connectivity timeout",
  "DB connection refused",
  "DB connection reset",
  "DB connection terminated",
  "DB connection closed",
  "DB unreachable",
]);
const CONNECTIVITY_ALERT_THROTTLE_MS = 5 * 60 * 1000; // in-memory, per-process
let lastConnectivityAlertAt = 0;

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

    // Option (c): ONE summarized alert per DB-connectivity outage window. The
    // per-error logs above are warn now (below the page threshold), so surface
    // a single "Supabase blipped" ping. The in-memory throttle is what stops
    // re-entry: the alert's OWN alertState query failing during the same outage
    // is itself a connectivity error — the `alertState` target skip + the
    // throttle both prevent it from re-firing the alert (the 2026-07-23 loop).
    if (
      classification?.retryable &&
      CONNECTIVITY_OUTAGE_CATEGORIES.has(classification.category) &&
      !e.target?.includes("alertState") &&
      Date.now() - lastConnectivityAlertAt > CONNECTIVITY_ALERT_THROTTLE_MS
    ) {
      lastConnectivityAlertAt = Date.now();
      const category = classification.category;
      const underlying = e.message;
      void import("./admin-alert")
        .then(({ notifyAdminAlert }) =>
          notifyAdminAlert({
            subject: "EA-SYS: database connectivity blip",
            body:
              `A transient database connection error occurred (${category}).\n` +
              `The app self-heals on the next query; this is one summarized alert for the outage window.\n\n` +
              `Underlying: ${underlying}`,
            dedupKey: "db-connectivity-outage",
            detail: underlying,
            logsSearch: "Prisma",
          }),
        )
        .catch(() => {
          // notifyAdminAlert is no-throw, but the dynamic import itself could
          // reject — never let alert plumbing poison the connector channel.
        });
    }
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

/**
 * Tenant-isolation query extension (multi-tenancy Phase 0 —
 * docs/MULTI_TENANCY.md §0). When RLS_SET_LOCAL=1 AND a tenant store is
 * active (src/lib/tenant-context.ts), every model operation is wrapped in a
 * batch transaction that first issues the transaction-scoped
 * `set_config('app.current_org', <orgId>, TRUE)` — i.e. SET LOCAL — so
 * Postgres RLS policies can filter by `current_setting('app.current_org')`.
 * Transaction-scoped is the ONLY pooler-safe shape: under the Supabase
 * pgbouncer transaction pooler each transaction gets one backend, so the
 * GUC and the query land on the same connection and never leak across
 * pooled clients. (This is the official Prisma-docs RLS pattern.)
 *
 * Master today: RLS_SET_LOCAL is unset → the extension is a pure
 * passthrough (one function frame per query, no behavior change). Nothing
 * in production populates the tenant store yet either — belt and braces.
 *
 * Deliberately NOT wrapped: `$queryRaw`/`$executeRaw`/`$transaction`
 * client-level ops. Under fail-closed RLS an unwrapped raw query sees zero
 * rows — the safe failure direction. Interactive transactions must use
 * `tenantTransaction()` below; ops inside it pass through via the
 * `inTenantTx` marker (wrapping them again would SET LOCAL on a DIFFERENT
 * pooled backend than the transaction's — wrong, plus deadlock risk).
 * ⚠ Phase-2 precondition (recorded in MULTI_TENANCY.md §13): migrate/audit
 * the existing `db.$transaction` sites to `tenantTransaction` per domain
 * BEFORE enabling RLS_SET_LOCAL anywhere real.
 */
function withTenantIsolation(base: ReturnType<typeof createPrismaClient>) {
  return base.$extends({
    name: "tenant-set-local",
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          if (process.env.RLS_SET_LOCAL !== "1") return query(args);
          const store = getTenantStore();
          if (!store?.orgId || store.inTenantTx) return query(args);
          const [, result] = await base.$transaction([
            base.$executeRaw`SELECT set_config('app.current_org', ${store.orgId}, TRUE)`,
            query(args) as Prisma.PrismaPromise<unknown>,
          ]);
          return result;
        },
      },
    },
  });
}

/**
 * The extension changes the client's TYPE to Prisma's DynamicClientExtension
 * shape, whose interactive-`$transaction` `tx` is structurally incompatible
 * with the `Prisma.TransactionClient` parameter type used by ~50 existing
 * service/helper signatures (measured: 52 tsc errors). The extension does NOT
 * change any operation signature or result shape at runtime — it only wraps
 * execution — so we confine the type noise here with a cast back to
 * PrismaClient (the pre-agreed fallback in the Phase-0 plan) instead of
 * rippling `TransactionClient` generics through the codebase.
 */
export const db =
  globalForPrisma.prisma ??
  (withTenantIsolation(createPrismaClient()) as unknown as PrismaClient);

/**
 * The sanctioned interactive-transaction entry point once tenancy is live:
 * issues the SET LOCAL on the transaction's own backend first, then marks the
 * async context `inTenantTx` so the query extension passes inner operations
 * through untouched. Flag off / no tenant store → behaves exactly like
 * `db.$transaction`.
 */
export async function tenantTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts?: { maxWait?: number; timeout?: number },
): Promise<T> {
  const orgId = getTenantOrgId();
  return db.$transaction(async (tx) => {
    if (process.env.RLS_SET_LOCAL === "1" && orgId) {
      await tx.$executeRaw`SELECT set_config('app.current_org', ${orgId}, TRUE)`;
    }
    return enterTenantTx(() => fn(tx));
  }, opts);
}

// Cache the client in dev to prevent HMR from creating new connections
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
