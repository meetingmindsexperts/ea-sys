/** GET the supplier list (classified fields redacted per caller); POST proposes one (request grant) or creates it approved (settle grant). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { canSettleProcurement, canViewSupplierFinancials } from "@/lib/procurement-visibility";
import { proposeSupplierSchema } from "@/procurement/lib/budget-schemas";
import { guardedRead, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { listSuppliers, proposeSupplier, redactSupplier } from "@/procurement/services/supplier-service";

export const SUPPLIER_STATUS: Record<string, number> = { INVALID_CODE: 400, CODE_TAKEN: 409, SUPPLIER_NOT_FOUND: 404, ALREADY_DECIDED: 409, STALE_WRITE: 409, UNKNOWN: 500 };
const ROUTE = "procurement/suppliers";
const STATUSES = new Set(["PROPOSED", "APPROVED", "REJECTED"]);

export async function GET(req: NextRequest) {
  const g = await procurementGuard({ route: ROUTE, need: "view" });
  if (!g.ok) return g.response;
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  if (status !== undefined && !STATUSES.has(status)) {
    apiLogger.warn({ msg: `${ROUTE}:invalid-status-filter`, status, userId: g.user.id });
    return NextResponse.json({ error: "Invalid status filter", code: "INVALID_FILTER" }, { status: 400 });
  }
  const includeInactive = url.searchParams.get("includeInactive") === "1";
  const canSee = canViewSupplierFinancials(g.user);
  return runWithTenant(g.orgId, () => guardedRead(ROUTE, g.user.id, async () => {
    const rows = await listSuppliers(g.orgId, { status: status as "PROPOSED" | "APPROVED" | "REJECTED" | undefined, includeInactive });
    return NextResponse.json({ suppliers: rows.map((r) => redactSupplier(r, canSee)) });
  }));
}

export async function POST(req: NextRequest) {
  const g = await procurementGuard({ route: ROUTE, need: "propose", write: true });
  if (!g.ok) return g.response;
  const parsed = proposeSupplierSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id });
  const canSee = canViewSupplierFinancials(g.user);
  return runWithTenant(g.orgId, async () => {
    const result = await proposeSupplier({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", approveOnCreate: canSettleProcurement(g.user), ...parsed.data });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, SUPPLIER_STATUS);
    return NextResponse.json({ supplier: redactSupplier(result.supplier, canSee) }, { status: 201 });
  });
}
