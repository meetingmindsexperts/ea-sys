/**
 * Pins the Prisma error classifier behaviour so a future Prisma upgrade
 * doesn't silently change the error-message text and collapse multiple
 * categories back into the generic "Prisma error" Sentry bucket — which
 * is exactly how Sentry issue 111629996 got to 6 events all titled
 * "Prisma error" with no way to tell connectivity from constraints
 * from the title alone.
 *
 * The classifier lives inline in src/lib/db.ts (no separate export — it's
 * a single-call-site internal). Exercised here via the side effect of
 * the client.$on("error") handler, by simulating the Prisma event and
 * asserting the dbLogger captured the right msg / classification.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted lifts shared state above the vi.mock factories so both the
// PrismaClient mock and the dbLogger mock can write to the same arrays.
// Without this, the mock factories run during module hoisting and can't
// see top-level `let` / `const` declarations.
const { eventHandlers, loggerCalls } = vi.hoisted(() => ({
  eventHandlers: { error: [], warn: [] } as Record<string, ((e: unknown) => void)[]>,
  loggerCalls: [] as Array<{ level: string; payload: Record<string, unknown> }>,
}));

vi.mock("@/lib/logger", () => ({
  dbLogger: {
    info: () => undefined,
    warn: () => undefined,
    error: (payload: Record<string, unknown>) => loggerCalls.push({ level: "error", payload }),
    debug: () => undefined,
  },
  apiLogger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
}));

// Mock PrismaClient as a real class so `new PrismaClient(...)` constructs.
// We don't need a real DB here; the classifier is pure-function-with-
// side-effects on log lines.
vi.mock("@prisma/client", () => ({
  PrismaClient: class FakePrismaClient {
    // PrismaClient is called with `new PrismaClient(options)` — we don't
    // care about the options, just need a constructor that accepts them.
    constructor() {}
    $on(event: string, handler: (e: unknown) => void) {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
    }
  },
}));

beforeEach(() => {
  loggerCalls.length = 0;
  eventHandlers.error = [];
  eventHandlers.warn = [];
  // db.ts caches the client on globalThis.prisma in non-production envs
  // (the HMR safety net). Clearing that + resetting modules forces a
  // fresh createPrismaClient() on the next import, which re-runs the
  // $on("error") registration into our mock event-handler array.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).prisma = undefined;
  vi.resetModules();
});

// Fires a synthetic Prisma error event through the registered handler,
// returns the resulting log payload so the test can assert against it.
async function fireError(message: string, target = "quaint::connector::postgres::native") {
  await import("@/lib/db");
  expect(eventHandlers.error.length, "error handler must be registered at module load").toBeGreaterThan(0);
  eventHandlers.error[0]({ message, target });
  const last = loggerCalls[loggerCalls.length - 1];
  expect(last, "an error log must have been emitted").toBeDefined();
  return last.payload;
}

describe("Prisma error classifier — connectivity errors", () => {
  it("classifies 'Connection timed out' (ETIMEDOUT) as retryable DB connectivity timeout", async () => {
    const payload = await fireError(
      "Error in PostgreSQL connection: Error { kind: Io, cause: Some(Os { code: 110, kind: TimedOut, message: \"Connection timed out\" }) }",
    );
    expect(payload.msg).toBe("DB connectivity timeout");
    expect(payload.classification).toBe("DB connectivity timeout");
    expect(payload.retryable).toBe(true);
    expect(payload.err).toBeInstanceOf(Error);
    expect((payload.err as Error).name).toBe("PrismaDBconnectivitytimeoutError");
  });

  it("classifies ECONNREFUSED as retryable DB connection refused", async () => {
    const payload = await fireError("getaddrinfo ENOTFOUND or ECONNREFUSED to db");
    expect(payload.msg).toBe("DB connection refused");
    expect(payload.retryable).toBe(true);
  });

  it("classifies ECONNRESET as retryable DB connection reset", async () => {
    const payload = await fireError("read ECONNRESET on socket");
    expect(payload.msg).toBe("DB connection reset");
    expect(payload.retryable).toBe(true);
  });

  it("classifies 'Connection terminated' as retryable", async () => {
    const payload = await fireError("Connection terminated unexpectedly by peer");
    expect(payload.msg).toBe("DB connection terminated");
    expect(payload.retryable).toBe(true);
  });

  it("classifies 'Can't reach database server' as retryable DB unreachable", async () => {
    const payload = await fireError("Can't reach database server at host:5432");
    expect(payload.msg).toBe("DB unreachable");
    expect(payload.retryable).toBe(true);
  });
});

describe("Prisma error classifier — non-retryable errors", () => {
  it("classifies authentication failure as non-retryable", async () => {
    const payload = await fireError("FATAL: password authentication failed for user 'foo'");
    expect(payload.msg).toBe("DB authentication failed");
    expect(payload.retryable).toBe(false);
  });

  it("classifies TLS errors as non-retryable", async () => {
    const payload = await fireError("Tls handshake failed: certificate verify failed");
    expect(payload.msg).toBe("DB TLS error");
    expect(payload.retryable).toBe(false);
  });
});

describe("Prisma error classifier — unknown messages", () => {
  it("falls back to 'Prisma error' title with null classification for unmatched messages", async () => {
    const payload = await fireError("some unexpected new error string from Prisma 7");
    expect(payload.msg).toBe("Prisma error");
    expect(payload.classification).toBeNull();
    expect(payload.retryable).toBeNull();
    // The fallback still wraps in a real Error so Sentry captureException
    // gets the stack — only the msg-based grouping changes.
    expect(payload.err).toBeInstanceOf(Error);
  });

  it("uses a placeholder message when Prisma emits an empty-string error", async () => {
    const payload = await fireError("");
    // Empty message → "Prisma error" title (no match), wrapped Error
    // carries the placeholder so Sentry doesn't render a totally blank
    // event body like it does for issue 111629996 today.
    expect(payload.msg).toBe("Prisma error");
    expect((payload.err as Error).message).toContain("(no message");
  });
});

describe("Prisma error classifier — feedback-loop guard preserved", () => {
  it("does NOT log systemLog target errors (would cause DB stream → log → DB feedback loop)", async () => {
    await import("@/lib/db");
    expect(eventHandlers.error.length).toBeGreaterThan(0);
    eventHandlers.error[0]({
      message: "Error in PostgreSQL connection: TimedOut",
      target: "quaint::query::systemLog",
    });
    expect(loggerCalls.length, "systemLog target must short-circuit before any log line").toBe(0);
  });
});

describe("Prisma error classifier — wrapped Error shape for Sentry", () => {
  it("attaches a wrapped Error object so Pino's err serializer triggers Sentry captureException", async () => {
    const payload = await fireError("Connection timed out");
    // Pino's standard err serializer expects `err` to be an Error
    // instance. Without that, Sentry forwarding goes via captureMessage
    // (string only) instead of captureException (stack + context).
    expect(payload.err).toBeInstanceOf(Error);
    // Name encodes the classification so Sentry's "Type" field shows
    // something more useful than "Error" for every DB hiccup.
    expect((payload.err as Error).name).toBe("PrismaDBconnectivitytimeoutError");
  });

  it("preserves the original raw fields (error, target) alongside the wrapped err for log grep back-compat", async () => {
    const payload = await fireError("Connection timed out", "quaint::connector::postgres::native");
    // Operators searching the prior `/logs?search=quaint::connector` queries
    // must still find these rows, so target stays on the top level.
    expect(payload.target).toBe("quaint::connector::postgres::native");
    expect(payload.error).toBe("Connection timed out");
  });
});
