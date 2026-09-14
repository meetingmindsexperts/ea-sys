/**
 * POST a CSV of suppliers (need "propose", the same rule as adding one):
 * a row whose code or legal name already exists is skipped and reported,
 * the rest are created through the propose path, so they land as Proposed
 * for the settle holder, or approved outright when the importer holds the
 * settle grant. Bank details are never importable (classified, spec §2.9);
 * the settle holder enters them per supplier. Audited as an import.
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { recordImport } from "@/lib/audit-data-transfer";
import { canSettleProcurement } from "@/lib/procurement-visibility";
import { importCsvSchema } from "@/procurement/lib/budget-schemas";
import { parseSupplierImport } from "@/procurement/lib/catalogue-import";
import { procurementGuard, readJson } from "@/procurement/lib/route-helpers";
import { importSuppliers } from "@/procurement/services/supplier-service";

const ROUTE = "procurement/suppliers/import";

export async function POST(req: NextRequest) {
  const g = await procurementGuard({ route: ROUTE, need: "propose", write: true });
  if (!g.ok) return g.response;
  const parsed = importCsvSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id });
  const file = parseSupplierImport(parsed.data.csv);
  if (file.fatal) {
    apiLogger.warn({ msg: `${ROUTE}:invalid-csv`, userId: g.user.id, reason: file.fatal });
    return NextResponse.json({ error: file.fatal, code: "INVALID_CSV" }, { status: 400 });
  }
  const approveOnCreate = canSettleProcurement(g.user);
  return runWithTenant(g.orgId, async () => {
    try {
      const r = await importSuppliers({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", approveOnCreate, rows: file.rows });
      const errors = [...file.errors, ...r.errors];
      void recordImport(req, {
        entityType: "Supplier",
        totalProcessed: file.totalRows,
        created: r.created,
        skipped: r.skipped.length,
        errors: errors.length,
        format: "csv",
        organizationId: g.orgId,
        userId: g.user.id,
        role: g.user.role ?? null,
      });
      return NextResponse.json({
        totalProcessed: file.totalRows,
        created: r.created,
        skipped: r.skipped.length,
        skippedDetails: r.skipped.map((s) => `Row ${s.rowNum}: ${s.reason}`),
        approved: approveOnCreate,
        errors,
      });
    } catch (err) {
      apiLogger.error({ msg: `${ROUTE}:failed`, userId: g.user.id, err });
      return NextResponse.json({ error: "The import failed part-way; suppliers already written stand. Check the list and retry the file.", code: "IMPORT_FAILED" }, { status: 500 });
    }
  });
}
