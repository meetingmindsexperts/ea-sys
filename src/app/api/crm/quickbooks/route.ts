/**
 * /api/crm/quickbooks: the CRM's view of the QuickBooks connection (Nov 4, 2026).
 *
 * GET: connected or not, which company, and the VAT codes quotes post with.
 *   Readable by anyone who works the CRM, so the deal screen can say why Send
 *   is unavailable. No token or secret is ever in it.
 * PUT: choose the VAT and no-VAT codes (quote-defaults admins only).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { runWithTenant } from "@/lib/tenant-context";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { crmAccounting } from "@/crm/integrations/accounting";
import { requireCrmRead, requireCrmWrite, crmCan, crmErrorResponse } from "@/crm/lib/crm-route";
import { readCrmQuickBooksSettings } from "@/crm/lib/quickbooks-rules";
import { saveQuickBooksTaxCodes } from "@/crm/services/crm-quickbooks-service";

export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    try {
      const [status, org] = await Promise.all([
        crmAccounting.connectionStatus(ctx.organizationId),
        db.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } }),
      ]);
      const settings = readCrmQuickBooksSettings(org?.settings);
      return NextResponse.json({
        connected: status.connected,
        environment: status.environment,
        companyName: status.companyName,
        realmId: status.realmId,
        // Codes chosen against another QuickBooks company do not count here.
        taxCodes: settings && settings.realmId === status.realmId ? settings : null,
        canManage: crmCan(ctx, "crm.quoteDefaults.manage"),
      });
    } catch (err) {
      apiLogger.error({ msg: "crm/quickbooks:status-failed", organizationId: ctx.organizationId, err: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: "Could not load the QuickBooks status" }, { status: 500 });
    }
  });
}

const putSchema = z.object({
  vatTaxCodeId: z.string().min(1).max(40),
  noVatTaxCodeId: z.string().min(1).max(40),
});

export async function PUT(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    if (!crmCan(ctx, "crm.quoteDefaults.manage")) {
      apiLogger.warn({ msg: "crm/quickbooks:tax-codes-forbidden", role: ctx.role, userId: ctx.userId, organizationId: ctx.organizationId });
      return NextResponse.json({ error: "Only an admin can choose the QuickBooks VAT codes", code: "FORBIDDEN" }, { status: 403 });
    }
    const parsed = putSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return zodErrorResponse(parsed, { route: "crm/quickbooks:PUT", organizationId: ctx.organizationId });

    const result = await saveQuickBooksTaxCodes({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      source: ctx.fromApiKey ? "api" : "rest",
      ...parsed.data,
    });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({ taxCodes: result.settings });
  });
}
