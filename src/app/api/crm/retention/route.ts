import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
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
      // The period and its audit row in ONE transaction: a period that deletes
      // data must never be saved unaudited (review of 6c8d9a24). One key set in
      // place, never a read-modify-write of the whole settings blob.
      await tenantTransaction(async (tx) => {
        const org = await tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } });
        const before = readCrmRetention(org?.settings);
        await tx.$executeRaw`UPDATE "Organization" SET "settings" = jsonb_set(COALESCE("settings", '{}'::jsonb), '{crmRetention}', ${JSON.stringify(parsed.data)}::jsonb), "updatedAt" = NOW() WHERE "id" = ${ctx.organizationId}`;
        await tx.auditLog.create({
          data: {
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            action: "CRM_RETENTION_SET",
            entityType: "Organization",
            entityId: ctx.organizationId,
            changes: { source: "rest", before, after: parsed.data },
          },
        });
      });
      apiLogger.info({ msg: "crm-retention:set", organizationId: ctx.organizationId, ...parsed.data });
      return NextResponse.json({ retention: parsed.data });
    } catch (err) {
      apiLogger.error({ msg: "crm-retention:set-failed", organizationId: ctx.organizationId, err: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: "Could not save the retention periods" }, { status: 500 });
    }
  });
}
