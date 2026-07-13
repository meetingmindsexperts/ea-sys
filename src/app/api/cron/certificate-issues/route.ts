/**
 * LEGACY cron shim — drives all CertificateIssueRun rows through their state
 * machine (auto-issue sweep → thank-you sweep → tickAllRuns).
 *
 * ⚠️ DEPRECATED ROLLBACK HANDLE (M5). The `ea-sys-worker` container's
 * `cert-issue` job (worker/jobs/cert-issue.ts) is the SOLE runner in prod —
 * these crontab lines were disabled June 9, 2026 and this route is kept ONLY
 * so it can be re-enabled if the worker tier is ever rolled back.
 *
 * It must STAY DISABLED while the worker runs. Unlike the worker job, this
 * route does NOT share the worker's `withJobLock` advisory lock — and it
 * can't meaningfully: both tiers connect through the Supabase transaction
 * pooler, where a session-scoped `pg_try_advisory_lock` isn't guaranteed to
 * hold across backends (the documented P3 limitation), so a shared lock would
 * be false safety, not real mutual exclusion. Running BOTH this route and the
 * worker concurrently double-drains runs + sweeps survey rows. On the rollback
 * path the worker is DOWN, so there's no contention — that's the only safe way
 * to use this route.
 *
 * EC2 crontab entry (rollback only):
 *   * * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     https://events.meetingmindsgroup.com/api/cron/certificate-issues
 *
 * Bearer-auth via CRON_SECRET — same pattern as the other cron workers.
 * Accepts both GET (Vercel cron) and POST (curl).
 */

import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { tickAllRuns } from "@/lib/certificates/issue-worker";
import { runAutoIssueSweep } from "@/lib/certificates/auto-issue";
import { runSurveyThankYouSweep } from "@/lib/certificates/survey-thankyou-sweep";

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
  // Loud marker (M5): this legacy shim shares NO lock with the worker. If the
  // worker is up, this line firing means BOTH are draining — surface it so an
  // operator notices an accidentally re-enabled crontab entry.
  apiLogger.warn({
    msg: "cert-issues-cron:legacy-shim-invoked",
    hint: "Deprecated rollback route — must stay disabled while the ea-sys-worker cert-issue job runs (no shared advisory lock).",
  });
  const started = Date.now();
  try {
    // Survey-gated auto-issue sweep first (enqueue new auto runs),
    // isolated so a sweep failure doesn't stop manual runs draining.
    try {
      await runAutoIssueSweep();
    } catch (sweepErr) {
      apiLogger.error({ err: sweepErr, msg: "cert-issues-cron:auto-issue-sweep-failed" });
    }
    // Deferred survey thank-you sweep — MUST run before tickAllRuns so it can
    // suppress the separate cover email for certs it delivers. Isolated.
    try {
      await runSurveyThankYouSweep();
    } catch (thankYouErr) {
      apiLogger.error({ err: thankYouErr, msg: "cert-issues-cron:survey-thankyou-sweep-failed" });
    }
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
