import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { requireCrmRead, crmErrorResponse } from "@/crm/lib/crm-route";
import { canViewDealValues } from "@/crm/lib/crm-visibility";
import { listDealQuotes } from "@/crm/services/crm-quote-service";

interface RouteParams {
  params: Promise<{ dealId: string }>;
}

/**
 * GET /api/crm/deals/[dealId]/quotes — the deal's saved quotes with their lines.
 *
 * A quote IS deal money, so a caller the deal-value redaction applies to gets an
 * empty list, the same rule the documents list applies to quote PDFs.
 */
export async function GET(req: Request, { params }: RouteParams) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmRead(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    if (!canViewDealValues(ctx.role, ctx.fromApiKey)) {
      return NextResponse.json({ quotes: [] });
    }
    const result = await listDealQuotes({ organizationId: ctx.organizationId, dealId });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({ quotes: result.quotes });
  });
}
