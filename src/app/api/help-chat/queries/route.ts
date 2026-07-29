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
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
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
  if (session.user.role !== "SUPER_ADMIN") {
    apiLogger.warn({
      msg: "help-chat-queries:forbidden",
      userId: session.user.id,
      role: session.user.role,
    });
    return NextResponse.json(
      { error: "Forbidden. Only super admins can read help-assistant queries." },
      { status: 403 },
    );
  }

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
      db.helpChatQuery.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.helpChatQuery.count({ where }),
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
