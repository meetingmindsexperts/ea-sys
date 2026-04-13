import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  syncWebinarAttendance,
  ATTENDANCE_FETCH_MIN_DELAY_MS,
  ATTENDANCE_FETCH_WINDOW_MS,
} from "@/lib/webinar-attendance";

const MAX_PER_TICK = 10;
const SERIAL_DELAY_MS = 500;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function handleCron(req: Request) {
  const startedAt = Date.now();
  try {
    const auth = req.headers.get("authorization");
    const expected = process.env.CRON_SECRET;

    if (!expected) {
      apiLogger.error({ msg: "webinar-attendance:misconfigured", reason: "CRON_SECRET not set" });
      return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    }
    if (auth !== `Bearer ${expected}`) {
      apiLogger.warn({ msg: "webinar-attendance:unauthorized" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
      apiLogger.debug({
        msg: "webinar-attendance:tick-empty",
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json({ processed: 0, results: [] });
    }

    apiLogger.info({
      msg: "webinar-attendance:tick-start",
      count: candidates.length,
    });

    // Serial processing with delay between rows when batch >3 to respect Zoom
    // rate limits. Per-row try/catch so one bad row can't kill the tick.
    const results: Array<{
      id: string;
      status: string;
      fetched?: number;
      upserted?: number;
      matched?: number;
      reason?: string;
    }> = [];

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        const result = await syncWebinarAttendance(candidate.id);
        results.push({
          id: candidate.id,
          status: result.status,
          fetched: "fetched" in result ? result.fetched : undefined,
          upserted: "upserted" in result ? result.upserted : undefined,
          matched: "matched" in result ? result.matched : undefined,
          reason: "reason" in result ? result.reason : undefined,
        });
      } catch (rowErr) {
        apiLogger.error(
          {
            err: rowErr,
            zoomMeetingDbId: candidate.id,
            msg: "webinar-attendance:row-crashed",
          },
        );
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

    apiLogger.info({
      msg: "webinar-attendance:tick-complete",
      processed: results.length,
      synced: syncedCount,
      pending: pendingCount,
      failed: failedCount,
      totalUpserted,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      processed: results.length,
      synced: syncedCount,
      pending: pendingCount,
      failed: failedCount,
      totalUpserted,
      results,
    });
  } catch (err) {
    apiLogger.error({
      err,
      msg: "webinar-attendance:tick-crashed",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ error: "Cron tick failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return handleCron(req);
}

export async function GET(req: Request) {
  return handleCron(req);
}
