/**
 * GET /api/crm/quickbooks/tax-codes: QuickBooks tax codes with their sales
 * rates, for the VAT-code picker (Nov 4, 2026). Quote-defaults admins only,
 * the same people who may save the choice.
 */
import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { crmCan, crmErrorResponse } from "@/crm/lib/crm-route";
import { crmAccounting } from "@/crm/integrations/accounting";
import { qboLookupFail, requireQboLookup } from "@/crm/lib/quickbooks-route";

export async function GET(req: Request) {
  const { error, ctx } = await requireQboLookup(req, "crm/quickbooks/tax-codes:GET");
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    if (!crmCan(ctx, "crm.quoteDefaults.manage")) {
      apiLogger.warn({ msg: "crm/quickbooks:tax-codes-list-forbidden", role: ctx.role, userId: ctx.userId, organizationId: ctx.organizationId });
      return NextResponse.json({ error: "Only an admin can choose the QuickBooks VAT codes", code: "FORBIDDEN" }, { status: 403 });
    }
    const res = await crmAccounting.listTaxCodes(ctx.organizationId);
    if (!res.ok) return crmErrorResponse(qboLookupFail(res, ctx.organizationId, "tax-codes"));
    return NextResponse.json({ taxCodes: res.data.filter((c) => c.active) });
  });
}
