/**
 * Thin HTTP shim around `runWebinarAttendanceTick()`.
 *
 * Authenticates the incoming cron request (Bearer CRON_SECRET) and
 * delegates the actual work to the shared worker library. See
 * docs/WORKER_EXTRACTION_PLAN.md for the Phase 1 refactor context.
 * The legacy crontab line stays untouched during this phase.
 */

import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { runWebinarAttendanceTick } from "@/lib/webinar-attendance-worker";

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

    const report = await runWebinarAttendanceTick();

    // Response envelope matches the pre-refactor shape so callers see
    // no observable change during the dual-write window.
    return NextResponse.json({
      processed: report.processed,
      synced: report.synced,
      pending: report.pending,
      failed: report.failed,
      totalUpserted: report.totalUpserted,
      results: report.results,
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
