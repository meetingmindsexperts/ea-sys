/**
 * GET a budget version as CSV (need "view"): a header block, one row per
 * line, then the totals, every figure ex-VAT with the tax beside it. Audited
 * as an export (who pulled which version), rate-limited per user, streamed
 * with a BOM so Excel reads it as UTF-8.
 *
 * Revenue and margin follow for a caller with finance sight, read through the
 * same service the page's Revenue and margin section uses. Without finance
 * sight the file carries one row saying revenue was left out, and the audit
 * row records which of the two the caller received.
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { recordExport } from "@/lib/audit-data-transfer";
import { canViewFinance } from "@/lib/finance-visibility";
import { buildBudgetCsv, budgetExportFilename, type ExportRevenueOption } from "@/procurement/lib/budget-export";
import { HTTP_STATUS_FOR_BUDGET_ERROR, HTTP_STATUS_FOR_REVENUE_ERROR, guardedRead, procurementGuard, rejected } from "@/procurement/lib/route-helpers";
import { getBudget } from "@/procurement/services/budget-service";
import { getBudgetRevenue } from "@/procurement/services/budget-revenue-service";

const ROUTE = "procurement/budgets/export";
const LIMIT = 60;
const WINDOW_SECONDS = 60 * 60;
/** Excel reads a CSV as UTF-8 only when it starts with the byte-order mark. */
const BOM = "\uFEFF";

export async function GET(req: NextRequest, { params }: { params: Promise<{ budgetId: string }> }) {
  const g = await procurementGuard({ route: ROUTE, need: "view" });
  if (!g.ok) return g.response;
  const { budgetId } = await params;
  const rl = checkRateLimit({ key: `${ROUTE}:user:${g.user.id}`, limit: LIMIT, windowMs: WINDOW_SECONDS * 1000 });
  if (!rl.allowed) {
    return rateLimited({ retryAfterSeconds: rl.retryAfterSeconds ?? WINDOW_SECONDS }, { route: ROUTE, userId: g.user.id, budgetId, limit: LIMIT, windowSeconds: WINDOW_SECONDS });
  }
  return runWithTenant(g.orgId, () =>
    guardedRead(ROUTE, g.user.id, async () => {
      const financeSight = canViewFinance(g.user.role);
      const [result, rev] = await Promise.all([getBudget(g.orgId, budgetId), financeSight ? getBudgetRevenue(g.orgId, budgetId) : null]);
      if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_BUDGET_ERROR);
      const b = result.budget;
      let revenue: ExportRevenueOption = "hidden";
      if (rev) {
        if (!rev.ok) return rejected(ROUTE, g.user.id, rev, HTTP_STATUS_FOR_REVENUE_ERROR);
        revenue = rev.value;
      } else {
        apiLogger.info({ msg: `${ROUTE}:revenue-omitted`, reason: "no-finance-sight", budgetId, userId: g.user.id, role: g.user.role });
      }
      const csv = buildBudgetCsv(b, new Date(), { revenue });
      const rowCount = b.lines?.length ?? 0;
      recordExport(req, {
        entityType: "EventBudget",
        rowCount,
        format: "csv",
        organizationId: g.orgId,
        userId: g.user.id,
        role: g.user.role ?? null,
        filters: { budgetId, eventCode: b.eventCode, versionNo: b.versionNo, status: b.status, revenue: revenue === "hidden" ? "omitted" : "included" },
      });
      apiLogger.info({ msg: `${ROUTE}:exported`, budgetId, eventCode: b.eventCode, versionNo: b.versionNo, rows: rowCount, userId: g.user.id });
      return new NextResponse(`${BOM}${csv}`, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${budgetExportFilename(b)}"`,
          "Cache-Control": "no-store",
        },
      });
    }),
  );
}
