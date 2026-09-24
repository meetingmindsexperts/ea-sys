/**
 * GET the supplier master as CSV (need "supplier-transfer": ADMIN and
 * SUPER_ADMIN by role, owner ruling 24 September 2026).
 *
 * Every supplier, any approval status, active or not. The columns are the
 * import's own, so the file round-trips, followed by three read-only columns
 * the importer ignores. Tax numbers are included (this population already sees
 * them); bank details are never read, let alone written. Audited as an export,
 * rate-limited per user, served with a BOM so Excel reads it as UTF-8.
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { recordExport } from "@/lib/audit-data-transfer";
import { buildSupplierCsv, supplierExportFilename } from "@/procurement/lib/supplier-export";
import { guardedRead, procurementGuard } from "@/procurement/lib/route-helpers";
import { listSuppliersForExport } from "@/procurement/services/supplier-service";

const ROUTE = "procurement/suppliers/export";
const LIMIT = 20;
const WINDOW_SECONDS = 60 * 60;
/** Excel reads a CSV as UTF-8 only when it starts with the byte-order mark. */
const BOM = "﻿";

export async function GET(req: NextRequest) {
  const g = await procurementGuard({ route: ROUTE, need: "supplier-transfer" });
  if (!g.ok) return g.response;
  const rl = checkRateLimit({ key: `${ROUTE}:user:${g.user.id}`, limit: LIMIT, windowMs: WINDOW_SECONDS * 1000 });
  if (!rl.allowed) {
    return rateLimited({ retryAfterSeconds: rl.retryAfterSeconds ?? WINDOW_SECONDS }, { route: ROUTE, userId: g.user.id, limit: LIMIT, windowSeconds: WINDOW_SECONDS });
  }
  return runWithTenant(g.orgId, () =>
    guardedRead(ROUTE, g.user.id, async () => {
      const suppliers = await listSuppliersForExport(g.orgId);
      const now = new Date();
      recordExport(req, {
        entityType: "Supplier",
        rowCount: suppliers.length,
        format: "csv",
        organizationId: g.orgId,
        userId: g.user.id,
        role: g.user.role ?? null,
        filters: { scope: "all", bankDetails: "excluded" },
      });
      apiLogger.info({ msg: `${ROUTE}:exported`, rows: suppliers.length, userId: g.user.id });
      return new NextResponse(`${BOM}${buildSupplierCsv(suppliers)}`, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${supplierExportFilename(now)}"`,
          "Cache-Control": "no-store",
        },
      });
    }),
  );
}
