/**
 * Thin HTTP shim around `runMcpOAuthCleanupTick()`.
 *
 * Authenticates the incoming cron request (Bearer CRON_SECRET) and
 * delegates the actual work to the shared worker library. See
 * docs/WORKER_EXTRACTION_PLAN.md for the Phase 1 refactor context.
 * The legacy crontab line stays untouched during this phase:
 *   0 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     https://events.meetingmindsgroup.com/api/cron/mcp-oauth-cleanup
 */

import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { runMcpOAuthCleanupTick } from "@/lib/mcp-oauth-cleanup-worker";

async function handleCron(req: Request) {
  const startedAt = Date.now();
  try {
    const authHeader = req.headers.get("authorization");
    const expected = process.env.CRON_SECRET;
    if (!expected) {
      apiLogger.error({ msg: "mcp-oauth-cleanup:misconfigured", reason: "CRON_SECRET not set" });
      return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    }
    if (authHeader !== `Bearer ${expected}`) {
      apiLogger.warn({ msg: "mcp-oauth-cleanup:unauthorized" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const report = await runMcpOAuthCleanupTick();

    // Response envelope matches the pre-refactor shape so callers see
    // no observable change during the dual-write window.
    return NextResponse.json({
      expiredCodes: report.expiredCodes,
      expiredTokens: report.expiredTokens,
      durationMs: report.durationMs,
    });
  } catch (err) {
    apiLogger.error({
      err,
      msg: "mcp-oauth-cleanup:tick-crashed",
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
