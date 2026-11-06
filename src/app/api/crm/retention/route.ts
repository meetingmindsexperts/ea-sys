import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { updateOrganizationSettings } from "@/lib/event-settings";
import { requireCrmRead, requireCrmPurge } from "@/crm/lib/crm-route";
import { crmRetentionSchema, readCrmRetention } from "@/crm/lib/retention-rules";

/**
 * GET / PUT /api/crm/retention: the organisation's CRM data retention periods
 * (lib/retention-rules.ts). Off by default. Setting one deletes old email and
 * notes for good, nightly, so the write takes the purge gate (SUPER_ADMIN
 * sessions only, API keys refused) and is audited.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const org = await db.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } });
    return NextResponse.json({ retention: readCrmRetention(org?.settings) });
  });
}

export async function PUT(req: Request) {
  const { error, ctx } = await requireCrmPurge(req);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const parsed = crmRetentionSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return zodErrorResponse(parsed, { route: "PUT /crm/retention", organizationId: ctx.organizationId });
    try {
      let before: unknown = null;
      await updateOrganizationSettings(ctx.organizationId, (current) => {
        before = readCrmRetention(current);
        return { ...current, crmRetention: parsed.data };
      });
      await db.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          action: "CRM_RETENTION_SET",
          entityType: "Organization",
          entityId: ctx.organizationId,
          changes: { source: "rest", before, after: parsed.data } as never,
        },
      });
      apiLogger.info({ msg: "crm-retention:set", organizationId: ctx.organizationId, ...parsed.data });
      return NextResponse.json({ retention: parsed.data });
    } catch (err) {
      apiLogger.error({ msg: "crm-retention:set-failed", organizationId: ctx.organizationId, err: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: "Could not save the retention periods" }, { status: 500 });
    }
  });
}
