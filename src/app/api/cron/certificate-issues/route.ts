/**
 * Cron worker — drives all CertificateIssueRun rows through their state
 * machine. Schedule: every minute (matches the existing scheduled-emails
 * cron pattern).
 *
 * EC2 crontab entry to add after deploy:
 *   * * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     https://events.meetingmindsgroup.com/api/cron/certificate-issues
 *
 * Bearer-auth via CRON_SECRET — same pattern as the other cron workers.
 * Accepts both GET (Vercel cron) and POST (curl).
 */

import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { tickAllRuns } from "@/lib/certificates/issue-worker";

function authorized(req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return auth === `Bearer ${secret}`;
}

async function run(req: Request) {
  if (!authorized(req)) {
    apiLogger.warn({
      msg: "cert-issues-cron:unauthorized",
      hasAuthHeader: req.headers.has("authorization"),
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  try {
    const result = await tickAllRuns();
    const durationMs = Date.now() - started;
    apiLogger.info({
      msg: "cert-issues-cron:tick",
      durationMs,
      ...result,
    });
    return NextResponse.json({ ok: true, durationMs, ...result });
  } catch (error) {
    apiLogger.error({
      err: error,
      msg: "cert-issues-cron:failed",
      durationMs: Date.now() - started,
    });
    return NextResponse.json({ error: "Cron tick failed" }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
