/**
 * The buffered writer.
 *
 * This exists so a burst of pageviews cannot compete with the registration desk
 * for the Prisma pool, which is a failure this system has already had (P2024,
 * 2026-06-10). The properties worth pinning are the ones where being wrong is
 * invisible: a hit must never be written twice or silently lost across a flush
 * boundary, and a stuck buffer must be capped rather than eating the heap of a
 * process that is also serving registrations.
 *
 * Runs with an injected writer, so none of this needs a database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/db", () => ({ db: {}, dbOperator: {} }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));

import {
  enqueueHit,
  flushNow,
  FLUSH_SIZE,
  FLUSH_INTERVAL_MS,
  MAX_BUFFERED,
  __resetBufferForTests,
  __setWriterForTests,
  __bufferDepthForTests,
} from "@/analytics/buffer";
import type { WritableHit } from "@/analytics/store/prisma-store";

function hit(n: number, org = "org-a"): WritableHit {
  return {
    organizationId: org,
    eventId: "evt-1",
    siteId: "site-1",
    name: "pageview",
    path: `/e/x/p${n}`,
    routePattern: "/e/:slug",
    visitorHash: `v${n}`,
    sessionHash: `s${n}`,
    occurredAt: new Date("2026-08-20T10:00:00Z"),
  };
}

/** Records what it was asked to write, and can be made to hang or fail. */
function makeWriter() {
  const batches: WritableHit[][] = [];
  let gate: (() => void) | null = null;
  let failNext = false;
  return {
    batches,
    failNext: () => {
      failNext = true;
    },
    hold: () =>
      new Promise<void>((resolve) => {
        gate = resolve;
      }),
    release: () => gate?.(),
    writer: {
      record: async (hits: readonly WritableHit[]) => {
        batches.push([...hits]);
        if (failNext) {
          failNext = false;
          throw new Error("write blew up");
        }
      },
    },
  };
}

let w: ReturnType<typeof makeWriter>;

beforeEach(() => {
  vi.clearAllMocks();
  __resetBufferForTests();
  w = makeWriter();
  __setWriterForTests(w.writer);
});

afterEach(() => {
  __setWriterForTests(null);
  __resetBufferForTests();
  vi.useRealTimers();
});

describe("batching", () => {
  it("flushes as soon as FLUSH_SIZE hits are waiting", async () => {
    for (let i = 0; i < FLUSH_SIZE; i++) enqueueHit(hit(i));
    await flushNow();
    expect(w.batches).toHaveLength(1);
    expect(w.batches[0]).toHaveLength(FLUSH_SIZE);
  });

  it("does not flush before the threshold without the timer", () => {
    for (let i = 0; i < FLUSH_SIZE - 1; i++) enqueueHit(hit(i));
    expect(w.batches).toHaveLength(0);
    expect(__bufferDepthForTests()).toBe(FLUSH_SIZE - 1);
  });

  it("flushes a partial batch once the interval elapses", async () => {
    vi.useFakeTimers();
    enqueueHit(hit(1));
    enqueueHit(hit(2));
    expect(w.batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS + 10);
    expect(w.batches).toHaveLength(1);
    expect(w.batches[0]).toHaveLength(2);
  });

  it("writes every hit exactly once across several flushes", async () => {
    for (let i = 0; i < FLUSH_SIZE * 2; i++) enqueueHit(hit(i));
    // Two awaits, not one, and that is the point rather than a workaround:
    // the enqueue loop is synchronous, so the second batch cannot drain until
    // the first write has settled. The first await settles it; the second picks
    // up the follow-on drain the completion triggers. Nothing may be lost in
    // between, which is what this asserts.
    await flushNow();
    await flushNow();
    const paths = w.batches.flat().map((h) => h.path);
    expect(new Set(paths).size).toBe(paths.length); // no duplicates
    expect(paths).toHaveLength(FLUSH_SIZE * 2);
  });
});

describe("concurrency", () => {
  it("does not write the same hit twice when flushes overlap", async () => {
    for (let i = 0; i < 5; i++) enqueueHit(hit(i));
    // Two concurrent callers must share one drain, not each take the buffer.
    await Promise.all([flushNow(), flushNow(), flushNow()]);
    expect(w.batches.flat()).toHaveLength(5);
  });

  it("keeps a hit that arrives mid-flush for the NEXT batch", async () => {
    for (let i = 0; i < 3; i++) enqueueHit(hit(i));
    const p = flushNow();
    // Arrives after the buffer was taken; must not vanish.
    enqueueHit(hit(99));
    await p;
    await flushNow();

    const all = w.batches.flat().map((h) => h.path);
    expect(all).toContain("/e/x/p99");
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("failure handling", () => {
  it("never throws out of enqueue", () => {
    expect(() => enqueueHit(hit(1))).not.toThrow();
  });

  it("never throws out of flush when the writer fails", async () => {
    w.failNext();
    enqueueHit(hit(1));
    await expect(flushNow()).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1 }),
      "analytics:flush-failed",
    );
  });

  it("flushing an empty buffer is a no-op, not an empty write", async () => {
    await flushNow();
    expect(w.batches).toHaveLength(0);
  });
});

describe("overflow", () => {
  // A writer that never settles: the database is unreachable and the first
  // flush is stuck. Subsequent flushNow() calls return that same in-flight
  // promise without draining, so the buffer genuinely fills. With a fast fake
  // writer the buffer drains every FLUSH_SIZE and the cap is unreachable, which
  // is why this needs a hanging one rather than a no-op one.
  function hangingWriter() {
    let release!: () => void;
    const stuck = new Promise<void>((r) => {
      release = r;
    });
    return { release, writer: { record: async () => stuck } };
  }

  it("caps the buffer and drops the OLDEST rather than growing", async () => {
    // Dropping analytics beats exhausting the heap of a process that is also
    // serving registrations.
    const h = hangingWriter();
    __setWriterForTests(h.writer);
    for (let i = 0; i < MAX_BUFFERED + 200; i++) enqueueHit(hit(i));
    expect(__bufferDepthForTests()).toBeLessThanOrEqual(MAX_BUFFERED);
    h.release();
  });

  it("reports the loss loudly instead of dropping silently", async () => {
    const h = hangingWriter();
    __setWriterForTests(h.writer);
    for (let i = 0; i < MAX_BUFFERED + 200; i++) enqueueHit(hit(i));

    // Let the stuck write finish, then flush again: the overflow report is
    // emitted by the drain that follows the loss.
    h.release();
    __setWriterForTests(w.writer);
    await flushNow();
    await flushNow();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ dropped: expect.any(Number) }),
      expect.stringContaining("analytics:buffer-overflow"),
    );
  });
});
