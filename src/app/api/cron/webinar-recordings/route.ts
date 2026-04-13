import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  syncRecordingForZoomMeeting,
  RECORDING_FETCH_WINDOW_MS,
  RECORDING_FETCH_MIN_DELAY_MS,
} from "@/lib/webinar-recording-sync";

// Per-tick budget. Each Zoom API call takes ~300-800ms plus the 500ms delay,
// so 10 rows ≈ 8-13s — well under any route timeout.
const MAX_PER_TICK = 10;

// Delay between serial Zoom API calls when processing >3 rows in one tick, to
// keep us comfortably under Zoom's 30 req/s rate limit.
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
      apiLogger.error({ msg: "webinar-recordings:misconfigured", reason: "CRON_SECRET not set" });
      return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    }
    if (auth !== `Bearer ${expected}`) {
      apiLogger.warn({ msg: "webinar-recordings:unauthorized" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
      apiLogger.debug(
        { msg: "webinar-recordings:tick-empty", durationMs: Date.now() - startedAt },
      );
      return NextResponse.json({ processed: 0, results: [] });
    }

    apiLogger.info(
      { msg: "webinar-recordings:tick-start", count: candidates.length },
    );

    // Serial processing to respect Zoom rate limits. Each sync handles its
    // own try/catch + persistence internally, but we add a defensive outer
    // try/catch here so one unexpected row crash can't skip the remaining
    // candidates in this tick.
    const results: Array<{ id: string; status: string; reason?: string }> = [];
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
        apiLogger.error(
          { err: rowErr, zoomMeetingDbId: candidate.id, msg: "webinar-recordings:row-crashed" },
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

    const availableCount = results.filter((r) => r.status === "available").length;
    const pendingCount = results.filter((r) => r.status === "pending").length;
    const failedCount = results.filter((r) => r.status === "failed").length;
    const expiredCount = results.filter((r) => r.status === "expired").length;

    apiLogger.info({
      msg: "webinar-recordings:tick-complete",
      processed: results.length,
      available: availableCount,
      pending: pendingCount,
      failed: failedCount,
      expired: expiredCount,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      processed: results.length,
      available: availableCount,
      pending: pendingCount,
      failed: failedCount,
      expired: expiredCount,
      results,
    });
  } catch (err) {
    apiLogger.error(
      { err, msg: "webinar-recordings:tick-crashed", durationMs: Date.now() - startedAt },
    );
    return NextResponse.json({ error: "Cron tick failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return handleCron(req);
}

export async function GET(req: Request) {
  return handleCron(req);
}
