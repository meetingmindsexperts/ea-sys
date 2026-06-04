/**
 * Webinar recordings worker — polls Zoom for recordings on webinar-type
 * ZoomMeeting rows whose session ended between 10 min and 7 days ago,
 * driving each through `syncRecordingForZoomMeeting`'s state machine.
 *
 * Extracted from `/api/cron/webinar-recordings/route.ts` as part of the
 * Phase 1 worker-extraction refactor (see
 * docs/WORKER_EXTRACTION_PLAN.md). The route handler now runs the
 * Bearer-CRON_SECRET auth check and delegates to
 * `runWebinarRecordingsTick()`; the same function will also be invoked
 * by the node-cron scheduler inside the worker process during Phase
 * 2-3. Behavior is unchanged from the previous all-in-the-route shape.
 *
 * Serial-processing pattern (kept verbatim from the route): we walk
 * candidates one at a time with a 500ms gap between each (when >3 are
 * in the batch) so we stay under Zoom's 30 req/s rate ceiling without
 * needing a token bucket. Each row's sync owns its own try/catch +
 * persistence; the outer try/catch here guards against an unexpected
 * crash skipping the remaining candidates in the same tick.
 */

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  syncRecordingForZoomMeeting,
  RECORDING_FETCH_WINDOW_MS,
  RECORDING_FETCH_MIN_DELAY_MS,
} from "@/lib/webinar-recording-sync";

// Per-tick budget. Each Zoom API call takes ~300-800ms plus the 500ms delay,
// so 10 rows ≈ 8-13s — well under any route timeout.
export const MAX_PER_TICK = 10;

// Delay between serial Zoom API calls when processing >3 rows in one tick, to
// keep us comfortably under Zoom's 30 req/s rate limit.
export const SERIAL_DELAY_MS = 500;

export interface WebinarRecordingsRowResult {
  id: string;
  status: string;
  reason?: string;
}

export interface WebinarRecordingsTickReport {
  processed: number;
  available: number;
  pending: number;
  failed: number;
  expired: number;
  results: WebinarRecordingsRowResult[];
  durationMs: number;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * One webinar-recordings cron tick. Pure async function — no HTTP, no
 * auth, no NextResponse. Callable from either the legacy route shim or
 * the future node-cron worker process.
 */
export async function runWebinarRecordingsTick(): Promise<WebinarRecordingsTickReport> {
  const startedAt = Date.now();
  const now = Date.now();
  const minEndedBefore = new Date(now - RECORDING_FETCH_MIN_DELAY_MS);
  const maxEndedAfter = new Date(now - RECORDING_FETCH_WINDOW_MS);

  // Candidates: webinar-type ZoomMeetings whose session ended between
  // 10 min and 7 days ago, that haven't been resolved yet.
  const candidates = await db.zoomMeeting.findMany({
    where: {
      meetingType: { in: ["WEBINAR", "WEBINAR_SERIES"] },
      recordingStatus: { in: ["NOT_REQUESTED", "PENDING"] },
      session: {
        endTime: {
          lt: minEndedBefore,
          gt: maxEndedAfter,
        },
      },
    },
    orderBy: { updatedAt: "asc" },
    take: MAX_PER_TICK,
    select: { id: true },
  });

  if (candidates.length === 0) {
    const durationMs = Date.now() - startedAt;
    apiLogger.debug({ msg: "webinar-recordings:tick-empty", durationMs });
    return {
      processed: 0,
      available: 0,
      pending: 0,
      failed: 0,
      expired: 0,
      results: [],
      durationMs,
    };
  }

  apiLogger.info({ msg: "webinar-recordings:tick-start", count: candidates.length });

  // Serial processing to respect Zoom rate limits. Each sync handles its
  // own try/catch + persistence internally, but we add a defensive outer
  // try/catch here so one unexpected row crash can't skip the remaining
  // candidates in this tick.
  const results: WebinarRecordingsRowResult[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const result = await syncRecordingForZoomMeeting(candidate.id);
      results.push({
        id: candidate.id,
        status: result.status,
        reason: "reason" in result ? result.reason : undefined,
      });
    } catch (rowErr) {
      apiLogger.error({
        err: rowErr,
        zoomMeetingDbId: candidate.id,
        msg: "webinar-recordings:row-crashed",
      });
      results.push({
        id: candidate.id,
        status: "failed",
        reason: rowErr instanceof Error ? rowErr.message : "unexpected row crash",
      });
    }
    if (i < candidates.length - 1 && candidates.length > 3) {
      await sleep(SERIAL_DELAY_MS);
    }
  }

  const availableCount = results.filter((r) => r.status === "available").length;
  const pendingCount = results.filter((r) => r.status === "pending").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const expiredCount = results.filter((r) => r.status === "expired").length;
  const durationMs = Date.now() - startedAt;

  apiLogger.info({
    msg: "webinar-recordings:tick-complete",
    processed: results.length,
    available: availableCount,
    pending: pendingCount,
    failed: failedCount,
    expired: expiredCount,
    durationMs,
  });

  return {
    processed: results.length,
    available: availableCount,
    pending: pendingCount,
    failed: failedCount,
    expired: expiredCount,
    results,
    durationMs,
  };
}
