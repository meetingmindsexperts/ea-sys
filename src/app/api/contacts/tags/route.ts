import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { getOrgContext } from "@/lib/api-auth";
import { denyContactAccess } from "@/lib/contact-visibility";

export async function GET(req: Request) {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Staff + MEMBER only — the tag vocabulary is CRM metadata (contacts review H1).
    const denied = denyContactAccess(ctx);
    if (denied) return denied;

    // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    return await runWithTenant(ctx.organizationId, async () => {

    // Aggregate in SQL rather than pulling every contact's tag array into Node.
    // The old shape was findMany({ select: { tags: true } }) over the whole
    // org — fine at 3k contacts, but it scales with the contact book and there
    // is no cap, so a large org paid a full table read to compute ~100 strings.
    // Prisma's query builder cannot express unnest, hence $queryRaw.
    const rows = await db.$queryRaw<{ tag: string; count: bigint }[]>`
      SELECT t AS tag, COUNT(*)::bigint AS count
      FROM "Contact" c, unnest(c.tags) AS t
      WHERE c."organizationId" = ${ctx.organizationId}
      GROUP BY t
      ORDER BY COUNT(*) DESC, t ASC`;

    // `tags` keeps its existing contract: distinct, alphabetical. Three callers
    // (contacts list filter, new-contact form, edit form) read it as string[].
    const tags = rows.map((r) => r.tag).sort((a, b) => a.localeCompare(b));
    // `usage` is additive — frequency-ordered, so a picker can surface the tags
    // people actually use instead of whatever sorts first alphabetically.
    const usage = rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));

    const response = NextResponse.json({ tags, usage });
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching contact tags" });
    return NextResponse.json({ error: "Failed to fetch tags" }, { status: 500 });
  }
}
