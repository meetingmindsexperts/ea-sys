import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireCrmRead } from "@/crm/lib/crm-route";

/**
 * GET /api/crm/companies/tags — the org's DISTINCT company (account) tags.
 *
 * Powers the "Any tag" filter on the companies list. Computed over the whole
 * non-archived org book (NOT the filtered view) so the filter always offers
 * every tag, even while one is active. Returns exact stored strings, so the
 * list's `?tags=` filter (an `hasSome` match) never mismatches on casing.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  // Tenancy: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {
    try {
      const rows = await db.crmCompany.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null },
        select: { tags: true },
      });
      const tags = [...new Set(rows.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b));
      return NextResponse.json({ tags });
    } catch (err) {
      apiLogger.error({
        msg: "crm/companies/tags:list-failed",
        organizationId: ctx.organizationId,
        err: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: "Could not load tags" }, { status: 500 });
    }
  });
}
