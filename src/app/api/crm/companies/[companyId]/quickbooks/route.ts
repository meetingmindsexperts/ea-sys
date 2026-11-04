/**
 * PUT /api/crm/companies/[companyId]/quickbooks: link the sponsor company to
 * an existing QuickBooks customer, or unlink it with `customerId: null`
 * (Nov 4, 2026). EA-SYS never creates QuickBooks customers.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { linkCompanyToCustomer } from "@/crm/services/crm-quickbooks-service";

const schema = z.object({ customerId: z.string().min(1).max(40).nullable() });

export async function PUT(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const [{ error, ctx }, { companyId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return zodErrorResponse(parsed, { route: "crm/companies/quickbooks:PUT", organizationId: ctx.organizationId, companyId });

    const result = await linkCompanyToCustomer({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      source: ctx.fromApiKey ? "api" : "rest",
      companyId,
      customerId: parsed.data.customerId,
    });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({ company: result.company });
  });
}
