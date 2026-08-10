import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireCrmRead } from "@/crm/lib/crm-route";

/**
 * GET /api/crm/companies/facets — the whole-book aggregates the list header needs.
 *
 * WHY THIS EXISTS. The page used to derive both of these from an UNFILTERED
 * `useCrmCompanies()` call, which is capped like every other list read. Past the
 * cap the "Needs review" badge under-counted (an operator reads "12 need review"
 * when it is 40) and any industry appearing only in rows past the cap vanished
 * from its own filter dropdown. A capped list is fine for a table that says so;
 * it is not fine as the source of a COUNT.
 *
 * Both are computed over the whole non-archived book, so they are correct
 * regardless of the list cap — and the page no longer fetches 1,000 rows it
 * only wanted two aggregates from.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  // Tenancy: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {
    try {
      const where = { organizationId: ctx.organizationId, archivedAt: null };
      const [industryRows, needsReviewCount] = await Promise.all([
        db.crmCompany.groupBy({
          by: ["industry"],
          where,
          orderBy: { industry: "asc" },
        }),
        db.crmCompany.count({ where: { ...where, needsReview: true } }),
      ]);

      const industries = industryRows
        .map((r) => r.industry)
        .filter((i): i is string => !!i)
        .sort((a, b) => a.localeCompare(b));

      return NextResponse.json({ industries, needsReviewCount });
    } catch (err) {
      apiLogger.error({
        msg: "crm/companies/facets:list-failed",
        organizationId: ctx.organizationId,
        err: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: "Could not load company filters" }, { status: 500 });
    }
  });
}
