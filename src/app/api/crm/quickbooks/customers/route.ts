/**
 * GET /api/crm/quickbooks/customers?search=: QuickBooks customers to link a
 * sponsor company to (Nov 4, 2026). Write-gated: only someone who can link
 * needs the list, and every search is a live call to QuickBooks.
 */
import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { crmErrorResponse } from "@/crm/lib/crm-route";
import { searchCustomers } from "@/lib/quickbooks/sales";
import { qboLookupFail, requireQboLookup } from "@/crm/lib/quickbooks-route";

export async function GET(req: Request) {
  const { error, ctx } = await requireQboLookup(req, "crm/quickbooks/customers:GET");
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const search = new URL(req.url).searchParams.get("search") ?? "";
    const res = await searchCustomers(ctx.organizationId, search);
    if (!res.ok) return crmErrorResponse(qboLookupFail(res, ctx.organizationId, "customers"));
    return NextResponse.json({ customers: res.data });
  });
}
