/**
 * GET /api/help-chat/queries
 *
 *   Read the captured help-assistant Q&A (HelpChatQuery). SUPER_ADMIN ONLY —
 *   questions can reference real attendee data, so this is the single, most
 *   restricted read surface (mirrors /api/logs). No org scoping: SUPER_ADMIN
 *   is cross-org by design, and the whole point is to see what everyone asks.
 *
 *   query params:
 *     q      optional free-text; ILIKE match on question OR answer
 *     page   1-based page (default 1)
 *     limit  page size (default 25, max 100)
 *
 *   response: { queries: HelpChatQuery[], total, page, limit }
 *   errors: 401 no session · 403 not SUPER_ADMIN
 *
 *   Tenancy (Domain #20, owner decision Aug 4 2026: operator-global): this
 *   read is deliberately CROSS-TENANT — the captured questions are the
 *   platform operator's product signal, so the route is NOT wrapped in a
 *   tenant lane. Under platform RLS an app-role query here fail-closes to
 *   zero rows — the platform must serve this route (and only this route)
 *   from the privileged maintenance lane, the same documented precondition
 *   class as the email-log-prune job and the aws-ops queue reads
 *   (MULTI_TENANCY.md §13). The RLS policy on HelpChatQuery still backstops
 *   every other app-lane query. Inert on master (no RLS; single org).
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { dbOperator } from "@/lib/db";
import { denyNonOperator } from "@/lib/platform-operator";
import { apiLogger } from "@/lib/logger";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Escape Postgres LIKE/ILIKE metacharacters so a `%` or `_` typed into the
 * search box matches literally instead of silently widening the result set
 * (Prisma's `contains` does NOT escape them — the registration-export lesson).
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "help-chat-queries:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Both walls (item 5): denyNonOperator is the RBAC one, dbOperator below is
  // the database one. This route reads across every tenant, so it needs both;
  // neither substitutes for the other. Replaces the hand-rolled SUPER_ADMIN
  // check so the operator boundary is defined in exactly one place.
  const denied = denyNonOperator(session, { route: "help-chat:queries" });
  if (denied) return denied;

  const { searchParams } = req.nextUrl;
  const q = (searchParams.get("q") ?? "").trim();
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(searchParams.get("limit")) || DEFAULT_LIMIT),
  );

  const where = q
    ? {
        OR: [
          {
            question: {
              contains: escapeLike(q),
              mode: "insensitive" as const,
            },
          },
          {
            answer: {
              contains: escapeLike(q),
              mode: "insensitive" as const,
            },
          },
        ],
      }
    : {};

  try {
    const [queries, total] = await Promise.all([
      dbOperator.helpChatQuery.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      dbOperator.helpChatQuery.count({ where }),
    ]);

    return NextResponse.json({ queries, total, page, limit });
  } catch (err) {
    apiLogger.error({
      msg: "help-chat-queries:fetch-failed",
      userId: session.user.id,
      err,
    });
    return NextResponse.json(
      { error: "Failed to load help-assistant queries." },
      { status: 500 },
    );
  }
}
