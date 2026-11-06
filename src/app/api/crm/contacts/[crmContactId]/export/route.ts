import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { recordExport } from "@/lib/audit-data-transfer";
import { requireCrmExport, crmErrorResponse } from "@/crm/lib/crm-route";
import { exportCrmContactData } from "@/crm/services/crm-privacy-service";

/**
 * GET /api/crm/contacts/[crmContactId]/export: everything the CRM holds on
 * one person, as a JSON download, for a subject-access request
 * (crm-privacy-service.ts). Export-gated (admin and above), audited like
 * every export.
 */
export async function GET(req: Request, { params }: { params: Promise<{ crmContactId: string }> }) {
  const [{ error, ctx }, { crmContactId }] = await Promise.all([requireCrmExport(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const result = await exportCrmContactData({ organizationId: ctx.organizationId, crmContactId });
    if (!result.ok) return crmErrorResponse(result);
    recordExport(req, {
      entityType: "CrmContact",
      rowCount: 1,
      format: "json",
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      role: ctx.role,
      source: ctx.fromApiKey ? "api" : "rest",
      filters: { crmContactId, kind: "subject-access" },
    });
    return new NextResponse(JSON.stringify(result.data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="crm-contact-${crmContactId}.json"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
