/**
 * GET /api/crm/quickbooks/items?search=: QuickBooks products/services to link
 * a catalogue product to (Nov 4, 2026). Write-gated, a live call each time.
 */
import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { crmErrorResponse } from "@/crm/lib/crm-route";
import { searchItems } from "@/lib/quickbooks/sales";
import { qboLookupFail, requireQboLookup } from "@/crm/lib/quickbooks-route";

export async function GET(req: Request) {
  const { error, ctx } = await requireQboLookup(req, "crm/quickbooks/items:GET");
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const search = new URL(req.url).searchParams.get("search") ?? "";
    const res = await searchItems(ctx.organizationId, search);
    if (!res.ok) return crmErrorResponse(qboLookupFail(res, ctx.organizationId, "items"));
    return NextResponse.json({ items: res.data });
  });
}
