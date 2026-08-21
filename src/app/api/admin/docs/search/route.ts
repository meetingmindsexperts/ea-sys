/**
 * GET /api/admin/docs/search?q=<query>
 *
 * Substring search across every allowed doc. Case-insensitive, literal
 * (not regex — protects against ReDoS from operator-typed patterns).
 * Caps results at 100 hits so a 2-char query can't burn CPU.
 *
 * Rate-limited 60/hr/user — defense in depth against a runaway client
 * polling the endpoint, and matches the pattern other CPU-touching
 * admin endpoints use. ADMIN + SUPER_ADMIN can hit this; REVIEWER /
 * SUBMITTER / REGISTRANT / MEMBER blocked.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyNonOperator } from "@/lib/platform-operator";
import { searchDocs } from "@/lib/docs-fs";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // PLATFORM OPERATOR only, narrowed from ADMIN on Aug 21 2026.
    //
    // This serves every .md and .html in the repository. The original comment
    // justified ADMIN access on the grounds that it "contains no secrets" —
    // true when every ADMIN was an MMG employee, and not the same claim once
    // ADMIN can mean a customer's administrator on the platform instance. What
    // is in here: our incident log, the AWS runbook with instance ids and
    // bucket names, the procedure for rebuilding our production box, the
    // security posture we gave a health authority, our multi-tenancy strategy
    // and our CRM plans. None of that is a tenant's to read.
    const denied = denyNonOperator(session, { route: "admin-docs:search" });
    if (denied) return denied;

    const rl = checkRateLimit({
      key: `admin-docs-search:${session.user.id}`,
      limit: 60,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "admin/docs/search:rate-limited", retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        {
          error: "Too many searches. Try again later.",
          code: "RATE_LIMITED",
          retryAfterSeconds: rl.retryAfterSeconds,
        },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    if (q.trim().length < 2) {
      return NextResponse.json({ hits: [] });
    }

    const hits = await searchDocs(q);
    return NextResponse.json({ hits });
  } catch (error) {
    apiLogger.error({ err: error, msg: "admin-docs:search:failed" });
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
