/**
 * Buffered writer for analytics hits.
 *
 * WHY BUFFER AT ALL
 * One INSERT per pageview would put public traffic on the same Prisma pool that
 * serves the registration desk. We have already had a P2024 pool-exhaustion
 * incident (2026-06-10), so this is a known failure mode rather than a
 * hypothetical one, and a burst of pageviews must never be able to starve a
 * check-in scan. Hits are collected in memory and written in batches, which is
 * exactly what logger.ts already does for the SystemLog stream.
 *
 * WHAT THIS COSTS, said plainly
 *   - A container restart loses up to FLUSH_INTERVAL_MS of hits. Acceptable:
 *     this is traffic measurement, not money.
 *   - Blue/green means both containers buffer independently. Fine; they write
 *     to the same table.
 *   - If the database is unreachable the buffer would grow without bound, so it
 *     is CAPPED. Past the cap the oldest hits are dropped and the loss is
 *     logged. Dropping analytics is always better than exhausting the heap of a
 *     process that is also serving registrations.
 */

import { apiLogger } from "@/lib/logger";
import { prismaAnalyticsWriter, type WritableHit } from "@/analytics/store/prisma-store";
import type { AnalyticsWriter } from "@/analytics/core/types";

/** Flush when this many hits are waiting. */
export const FLUSH_SIZE = 25;
/** Or when this long has passed since the first hit in the batch. */
export const FLUSH_INTERVAL_MS = 2000;
/**
 * Hard ceiling. At roughly 200 bytes a hit this is a few megabytes, which is
 * survivable, and it is only ever reached when writes are failing.
 */
export const MAX_BUFFERED = 10_000;

/**
 * Where batches go. Injectable so the batching rules can be tested without a
 * database, which is the same principle core/ follows: a seam nothing can use
 * is decoration.
 */
let writer: AnalyticsWriter<WritableHit> = prismaAnalyticsWriter;

let buffer: WritableHit[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let dropped = 0;
/** Serialises flushes so two cannot write the same hits twice. */
let inFlight: Promise<void> | null = null;

async function drain(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (buffer.length === 0) return;

  // Take the whole buffer up front. A hit arriving mid-write lands in the fresh
  // array and is flushed next round, rather than being written twice or lost.
  const batch = buffer;
  buffer = [];

  if (dropped > 0) {
    apiLogger.error(
      { dropped, cap: MAX_BUFFERED },
      "analytics:buffer-overflow — hits were discarded because writes are failing",
    );
    dropped = 0;
  }

  try {
    await writer.record(batch);
  } catch (err) {
    // The Prisma writer already swallows and logs per-org failures, so reaching here
    // means something unexpected. Still must not propagate: nothing upstream
    // should fail because a pageview did not save.
    apiLogger.error({ err, count: batch.length }, "analytics:flush-failed");
  }
}

function scheduleFlush(): void {
  if (timer) return;
  timer = setTimeout(() => {
    void flushNow();
  }, FLUSH_INTERVAL_MS);
  // Do not hold the process open for a pending analytics flush.
  timer.unref?.();
}

/** Flush, serialised. Safe to call concurrently. */
export function flushNow(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = drain().finally(() => {
    inFlight = null;
    // A flush that ran WHILE hits were still arriving leaves a non-empty buffer
    // behind. Without this it has no timer pending either, because the enqueue
    // path returns early once it has triggered a flush, so those hits would sit
    // there until another hit happened to arrive. Under a burst that ends
    // abruptly, which is what the end of a registration rush looks like, the
    // last batch would simply never be written. Found by the "writes every hit
    // exactly once" test, which is the reason that test exists.
    if (buffer.length >= FLUSH_SIZE) {
      // Already full again. Draining now rather than waiting out the interval
      // keeps the size trigger meaningful under sustained load; otherwise every
      // batch after the first would be time-based no matter how fast hits
      // arrive.
      void flushNow();
    } else if (buffer.length > 0) {
      scheduleFlush();
    }
  });
  return inFlight;
}

/**
 * Queue a hit. Returns immediately; the caller never waits on the database.
 *
 * NEVER THROWS. The ingest route answers 204 whatever happens here, because a
 * failing beacon must not be visible to a visitor who is trying to register.
 */
export function enqueueHit(hit: WritableHit): void {
  try {
    if (buffer.length >= MAX_BUFFERED) {
      // Drop the OLDEST rather than refusing the newest: recent traffic is what
      // anyone is looking at, and old hits in a stuck buffer are already stale.
      buffer.shift();
      dropped++;
    }
    buffer.push(hit);

    if (buffer.length >= FLUSH_SIZE) {
      void flushNow();
      // If a flush was already in flight, flushNow() did NOT drain, so these
      // hits are still waiting. Ensure a timer either way.
      if (buffer.length > 0) scheduleFlush();
      return;
    }
    scheduleFlush();
  } catch (err) {
    apiLogger.error({ err }, "analytics:enqueue-failed");
  }
}

/** Test seam. Not for production use. */
export function __resetBufferForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  buffer = [];
  dropped = 0;
  inFlight = null;
}

/** Test seam. Not for production use. */
export function __bufferDepthForTests(): number {
  return buffer.length;
}

/** Test seam. Not for production use. */
export function __setWriterForTests(w: AnalyticsWriter<WritableHit> | null): void {
  writer = w ?? prismaAnalyticsWriter;
}
