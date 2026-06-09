/**
 * Pins withJobLock's behaviour, in particular the P1 fix: a transient
 * pooler dropout on the lock-ACQUIRE query (Supabase `EDBHANDLEREXITED` /
 * `Error { kind: Closed }`) must be swallowed as a quiet skip — log at
 * warn, return null, do NOT run the tick, do NOT re-throw — so it never
 * escapes to the scheduler's `worker:tick-wrapper-uncaught` alert. Any
 * NON-retryable acquire error must still re-throw.
 *
 * We use the REAL src/lib/db.ts (so the REAL classifyPrismaError runs) on
 * top of a faked @prisma/client whose $queryRaw we drive, rather than
 * mocking @/lib/db — that keeps the classification decision honest.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { queryRawMock, loggerCalls } = vi.hoisted(() => ({
  queryRawMock: vi.fn(),
  loggerCalls: [] as Array<{ level: string; payload: Record<string, unknown> }>,
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: {
    info: () => undefined,
    debug: (payload: Record<string, unknown>) => loggerCalls.push({ level: "debug", payload }),
    warn: (payload: Record<string, unknown>) => loggerCalls.push({ level: "warn", payload }),
    error: (payload: Record<string, unknown>) => loggerCalls.push({ level: "error", payload }),
  },
  dbLogger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: class FakePrismaClient {
    constructor() {}
    $on() {}
    $queryRaw(...args: unknown[]) {
      return queryRawMock(...args);
    }
  },
}));

import { withJobLock } from "../../worker/lib/advisory-lock";

beforeEach(() => {
  queryRawMock.mockReset();
  loggerCalls.length = 0;
});

describe("withJobLock", () => {
  it("runs fn and unlocks when the lock is acquired", async () => {
    queryRawMock
      .mockResolvedValueOnce([{ locked: true }]) // acquire
      .mockResolvedValueOnce([]); // unlock
    const fn = vi.fn().mockResolvedValue("DONE");

    const result = await withJobLock(42, "test-job", fn);

    expect(result).toBe("DONE");
    expect(fn).toHaveBeenCalledOnce();
    expect(queryRawMock).toHaveBeenCalledTimes(2); // acquire + unlock
  });

  it("skips fn (returns null) when another session holds the lock", async () => {
    queryRawMock.mockResolvedValueOnce([{ locked: false }]); // acquire → not ours
    const fn = vi.fn();

    const result = await withJobLock(42, "test-job", fn);

    expect(result).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(loggerCalls.some((c) => c.payload.msg === "worker:skip-tick-locked")).toBe(true);
  });

  it("P1: swallows a transient connection-closed on ACQUIRE — warn + skip, no throw", async () => {
    queryRawMock.mockRejectedValueOnce(
      new Error(
        "Invalid `prisma.$queryRaw()` invocation: Error in connector: Error querying the database: FATAL: (EDBHANDLEREXITED) connection to database closed",
      ),
    );
    const fn = vi.fn();

    const result = await withJobLock(42, "webinar-recordings", fn);

    expect(result).toBeNull();
    expect(fn).not.toHaveBeenCalled(); // tick never ran
    const last = loggerCalls[loggerCalls.length - 1];
    expect(last.level).toBe("warn"); // below the alert threshold
    expect(last.payload.msg).toBe("worker:lock-acquire-transient-skip");
    expect(last.payload.classification).toBe("DB connection closed");
  });

  it("re-throws a NON-retryable acquire error (real problems still surface)", async () => {
    queryRawMock.mockRejectedValueOnce(
      new Error("FATAL: password authentication failed for user 'foo'"),
    );
    const fn = vi.fn();

    await expect(withJobLock(42, "test-job", fn)).rejects.toThrow(/authentication failed/);
    expect(fn).not.toHaveBeenCalled();
  });
});
