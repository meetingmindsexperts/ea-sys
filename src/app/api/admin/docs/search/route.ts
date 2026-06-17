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
import { searchDocs } from "@/lib/docs-fs";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN") {
      apiLogger.warn({
        msg: "admin-docs:search:forbidden",
        userId: session.user.id,
        role: session.user.role,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
