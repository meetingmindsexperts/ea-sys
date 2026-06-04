/**
 * Webinar attendance worker — polls Zoom for participant + engagement
 * (polls + Q&A) reports on webinar-type ZoomMeeting rows. Drives each
 * candidate through `syncWebinarAttendance` then chains
 * `syncWebinarEngagement` on the same tick (two extra Zoom API calls
 * per row, piggybacked to avoid a second cron walk over the same
 * candidate set).
 *
 * Extracted from `/api/cron/webinar-attendance/route.ts` as part of
 * the Phase 1 worker-extraction refactor (see
 * docs/WORKER_EXTRACTION_PLAN.md). The route handler is now a thin
 * shim that auth-checks the Bearer CRON_SECRET and delegates to
 * `runWebinarAttendanceTick()`; the same function will be invoked by
 * the node-cron worker process during Phase 2-3. Behavior is
 * unchanged from the previous all-in-the-route shape.
 *
 * Candidate rule (kept verbatim from the route):
 *   webinar-type ZoomMeetings whose session ended between 30 min and
 *   30 days ago, where either:
 *     (a) attendance was never synced (catches every eligible row), or
 *     (b) last synced >1h ago AND session ended <24h ago (the late-
 *         reconcile window where late-joining participants still show
 *         up in Zoom's report)
 *
 * Engagement piggyback rule: own try/catch around `syncWebinarEngagement`
 * so a polls/Q&A failure never masks or overrides the attendance
 * result. Both runs share the same tick-level rate-limit delay.
 */

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  syncWebinarAttendance,
  ATTENDANCE_FETCH_MIN_DELAY_MS,
  ATTENDANCE_FETCH_WINDOW_MS,
} from "@/lib/webinar-attendance";
import { syncWebinarEngagement } from "@/lib/webinar-engagement";

export const MAX_PER_TICK = 10;
export const SERIAL_DELAY_MS = 500;

export interface WebinarAttendanceEngagementResult {
  status: string;
  pollsPersisted?: number;
  pollResponsesPersisted?: number;
  questionsPersisted?: number;
}

export interface WebinarAttendanceRowResult {
  id: string;
  status: string;
  fetched?: number;
  upserted?: number;
  matched?: number;
  engagement?: WebinarAttendanceEngagementResult;
  reason?: string;
}

export interface WebinarAttendanceTickReport {
  processed: number;
  synced: number;
  pending: number;
  failed: number;
  totalUpserted: number;
  results: WebinarAttendanceRowResult[];
  durationMs: number;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * One webinar-attendance cron tick. Pure async function — no HTTP, no
 * auth, no NextResponse. Callable from either the legacy route shim or
 * the future node-cron worker process.
 */
export async function runWebinarAttendanceTick(): Promise<WebinarAttendanceTickReport> {
  const startedAt = Date.now();
  const now = Date.now();
  const minEndedBefore = new Date(now - ATTENDANCE_FETCH_MIN_DELAY_MS);
  const maxEndedAfter = new Date(now - ATTENDANCE_FETCH_WINDOW_MS);
  // Hourly re-sync is only allowed within 24h of session end — that's the
  // window where late-joining participant records still show up in Zoom's
  // report. After 24h, one successful sync is enough; the row stays out
  // of the cron's sight until an admin explicitly hits "Sync now".
  const recentEndCutoff = new Date(now - 24 * 60 * 60 * 1000);
  const oneHourAgo = new Date(now - 60 * 60 * 1000);

  // Candidates: webinar-type ZoomMeetings whose session ended between
  // 30 min and 30 days ago. Either:
  //   (a) never synced (catches every eligible row regardless of age), or
  //   (b) last synced >1h ago AND session ended <24h ago (late-reconcile).
  const candidates = await db.zoomMeeting.findMany({
    where: {
      AND: [
        {
          meetingType: { in: ["WEBINAR", "WEBINAR_SERIES"] },
          session: {
            endTime: {
              lt: minEndedBefore,
              gt: maxEndedAfter,
            },
          },
        },
        {
          OR: [
            { lastAttendanceSyncAt: null },
            {
              AND: [
                { lastAttendanceSyncAt: { lt: oneHourAgo } },
                { session: { endTime: { gt: recentEndCutoff } } },
              ],
            },
          ],
        },
      ],
    },
    orderBy: [{ lastAttendanceSyncAt: { sort: "asc", nulls: "first" } }],
    take: MAX_PER_TICK,
    select: { id: true },
  });

  if (candidates.length === 0) {
    const durationMs = Date.now() - startedAt;
    apiLogger.debug({ msg: "webinar-attendance:tick-empty", durationMs });
    return {
      processed: 0,
      synced: 0,
      pending: 0,
      failed: 0,
      totalUpserted: 0,
      results: [],
      durationMs,
    };
  }

  apiLogger.info({ msg: "webinar-attendance:tick-start", count: candidates.length });

  // Serial processing with delay between rows when batch >3 to respect Zoom
  // rate limits. Per-row try/catch so one bad row can't kill the tick.
  // Each row runs attendance sync first, then engagement sync (polls + Q&A)
  // piggybacked on the same tick — two extra Zoom API calls per row.
  const results: WebinarAttendanceRowResult[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const result = await syncWebinarAttendance(candidate.id);
      const resultRow: WebinarAttendanceRowResult = {
        id: candidate.id,
        status: result.status,
        fetched: "fetched" in result ? result.fetched : undefined,
        upserted: "upserted" in result ? result.upserted : undefined,
        matched: "matched" in result ? result.matched : undefined,
        reason: "reason" in result ? result.reason : undefined,
      };

      // Piggyback engagement sync onto the same tick. Own try/catch so a
      // polls/Q&A failure never masks or overrides the attendance result.
      try {
        const engagement = await syncWebinarEngagement(candidate.id);
        resultRow.engagement = {
          status: engagement.status,
          pollsPersisted:
            "pollsPersisted" in engagement ? engagement.pollsPersisted : undefined,
          pollResponsesPersisted:
            "pollResponsesPersisted" in engagement
              ? engagement.pollResponsesPersisted
              : undefined,
          questionsPersisted:
            "questionsPersisted" in engagement ? engagement.questionsPersisted : undefined,
        };
      } catch (engagementErr) {
        apiLogger.error({
          err: engagementErr,
          zoomMeetingDbId: candidate.id,
          msg: "webinar-attendance:engagement-row-crashed",
        });
        resultRow.engagement = { status: "failed" };
      }

      results.push(resultRow);
    } catch (rowErr) {
      apiLogger.error({
        err: rowErr,
        zoomMeetingDbId: candidate.id,
        msg: "webinar-attendance:row-crashed",
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

  const syncedCount = results.filter((r) => r.status === "synced").length;
  const pendingCount = results.filter((r) => r.status === "pending").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const totalUpserted = results.reduce((sum, r) => sum + (r.upserted ?? 0), 0);
  const durationMs = Date.now() - startedAt;

  apiLogger.info({
    msg: "webinar-attendance:tick-complete",
    processed: results.length,
    synced: syncedCount,
    pending: pendingCount,
    failed: failedCount,
    totalUpserted,
    durationMs,
  });

  return {
    processed: results.length,
    synced: syncedCount,
    pending: pendingCount,
    failed: failedCount,
    totalUpserted,
    results,
    durationMs,
  };
}
