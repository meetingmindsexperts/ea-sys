import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * Hourly cleanup cron for MCP OAuth state.
 *
 * Deletes:
 *  - Expired authorization codes (TTL = 10 min, leaked on abandoned flows)
 *  - Access tokens that expired over 7 days ago (grace period for refresh)
 *
 * Reuses the same Bearer $CRON_SECRET pattern as /api/cron/scheduled-emails
 * and /api/cron/webinar-*. EC2 crontab entry:
 *   0 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     https://events.meetingmindsgroup.com/api/cron/mcp-oauth-cleanup
 */

const TOKEN_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

    const now = new Date();
    const tokenCutoff = new Date(now.getTime() - TOKEN_GRACE_PERIOD_MS);

    const [codes, tokens] = await Promise.all([
      db.mcpOAuthAuthCode.deleteMany({ where: { expiresAt: { lt: now } } }),
      db.mcpOAuthAccessToken.deleteMany({ where: { expiresAt: { lt: tokenCutoff } } }),
    ]);

    apiLogger.info({
      msg: "mcp-oauth-cleanup:tick-complete",
      expiredCodes: codes.count,
      expiredTokens: tokens.count,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      expiredCodes: codes.count,
      expiredTokens: tokens.count,
      durationMs: Date.now() - startedAt,
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
