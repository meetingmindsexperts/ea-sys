/**
 * Thin HTTP shim around `runScheduledEmailsTick()`.
 *
 * Authenticates the incoming cron request (Bearer CRON_SECRET) and
 * delegates the actual work to the shared worker library. During the
 * Phase 1 worker-extraction refactor (docs/WORKER_EXTRACTION_PLAN.md)
 * this is the ONLY caller; in Phase 2-3 the same function will also be
 * invoked by the node-cron scheduler inside the worker process.
 *
 * The legacy crontab line stays untouched during this phase:
 *   * * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *       https://events.meetingmindsgroup.com/api/cron/scheduled-emails
 *
 * Phase 4 (after the dual-write window) will delete this file. Until
 * then it MUST stay functionally identical to the pre-refactor handler
 * — same auth contract, same response envelope shape.
 */

import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { runScheduledEmailsTick } from "@/lib/scheduled-emails-worker";

async function handleCron(req: Request) {
  const startedAt = Date.now();
  try {
    const auth = req.headers.get("authorization");
    const expected = process.env.CRON_SECRET;

    if (!expected) {
      apiLogger.error({ msg: "scheduled-emails:misconfigured", reason: "CRON_SECRET not set" });
      return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    }

    if (auth !== `Bearer ${expected}`) {
      apiLogger.warn({ msg: "scheduled-emails:unauthorized" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const report = await runScheduledEmailsTick();

    // Response envelope matches the pre-refactor shape so any client
    // (curl, Vercel cron, future monitoring) sees no observable change.
    return NextResponse.json({
      processed: report.processed,
      sent: report.sent,
      failed: report.failed,
      swept: report.swept,
      results: report.results,
    });
  } catch (err) {
    apiLogger.error({
      err,
      msg: "scheduled-emails:tick-crashed",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ error: "Cron tick failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return handleCron(req);
}

// Allow GET as well so basic curl and Vercel cron (which uses GET by default) both work.
export async function GET(req: Request) {
  return handleCron(req);
}
