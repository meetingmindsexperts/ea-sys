/**
 * POST a CSV of catalogue products (need "admin"): an existing SKU is
 * updated, a new one is created, nothing is deleted. The file travels as
 * text in the JSON body; the parser reports every unreadable row and the
 * readable ones go through the same create/update rules the dialogs use.
 * Audited as an import with its counts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { recordImport } from "@/lib/audit-data-transfer";
import { importCsvSchema } from "@/procurement/lib/budget-schemas";
import { parseProductImport } from "@/procurement/lib/catalogue-import";
import { procurementGuard, readJson } from "@/procurement/lib/route-helpers";
import { importBudgetProducts } from "@/procurement/services/budget-product-service";

const ROUTE = "procurement/products/import";

export async function POST(req: NextRequest) {
  const g = await procurementGuard({ route: ROUTE, need: "admin", write: true });
  if (!g.ok) return g.response;
  const parsed = importCsvSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id });
  const file = parseProductImport(parsed.data.csv);
  if (file.fatal) {
    apiLogger.warn({ msg: `${ROUTE}:invalid-csv`, userId: g.user.id, reason: file.fatal });
    return NextResponse.json({ error: file.fatal, code: "INVALID_CSV" }, { status: 400 });
  }
  return runWithTenant(g.orgId, async () => {
    try {
      const r = await importBudgetProducts({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", rows: file.rows });
      const errors = [...file.errors, ...r.errors];
      void recordImport(req, {
        entityType: "BudgetProduct",
        totalProcessed: file.totalRows,
        created: r.created,
        updated: r.updated,
        skipped: r.unchanged,
        errors: errors.length,
        format: "csv",
        organizationId: g.orgId,
        userId: g.user.id,
        role: g.user.role ?? null,
      });
      return NextResponse.json({ totalProcessed: file.totalRows, created: r.created, updated: r.updated, unchanged: r.unchanged, errors });
    } catch (err) {
      apiLogger.error({ msg: `${ROUTE}:failed`, userId: g.user.id, err });
      return NextResponse.json({ error: "The import failed part-way; rows already written stand. Check the catalogue and retry the file.", code: "IMPORT_FAILED" }, { status: 500 });
    }
  });
}
