/**
 * Thin HTTP shim around `runWebinarRecordingsTick()`.
 *
 * Authenticates the incoming cron request (Bearer CRON_SECRET) and
 * delegates the actual work to the shared worker library. See
 * docs/WORKER_EXTRACTION_PLAN.md for the Phase 1 refactor context.
 * The legacy crontab line stays untouched during this phase.
 */

import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { runWebinarRecordingsTick } from "@/lib/webinar-recordings-worker";

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

    const report = await runWebinarRecordingsTick();

    // Response envelope matches the pre-refactor shape so callers see
    // no observable change during the dual-write window.
    return NextResponse.json({
      processed: report.processed,
      available: report.available,
      pending: report.pending,
      failed: report.failed,
      expired: report.expired,
      results: report.results,
    });
  } catch (err) {
    apiLogger.error({
      err,
      msg: "webinar-recordings:tick-crashed",
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
