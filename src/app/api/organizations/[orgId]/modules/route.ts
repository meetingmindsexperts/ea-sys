import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { denyNonOperator } from "@/lib/platform-operator";
import { tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { ORG_MODULES, forgetOrgModules } from "@/lib/module-entitlements";

/**
 * PUT /api/organizations/[orgId]/modules: switch one module on or off for one
 * organisation (module-entitlements.ts). PLATFORM OPERATOR ONLY: an
 * organisation's own SUPER_ADMIN must not be able to grant itself a module it
 * has not bought. Switching off suspends, it deletes nothing. Every change
 * writes an AuditLog row in the same transaction as the change.
 */
const schema = z.object({ module: z.enum(ORG_MODULES), enabled: z.boolean() });

export async function PUT(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const [session, { orgId }] = await Promise.all([auth(), params]);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyNonOperator(session, { route: "organizations/[orgId]/modules:PUT" });
  if (denied) return denied;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    apiLogger.warn({ msg: "organizations-modules:invalid-body", orgId, errors: parsed.error.flatten().fieldErrors });
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten().fieldErrors }, { status: 400 });
  }
  const { module, enabled } = parsed.data;

  try {
    // In the TARGET organisation's lane, so the AuditLog insert passes RLS on the platform.
    const result = await runWithTenant(orgId, () => tenantTransaction(async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: orgId }, select: { enabledModules: true } });
      if (!org) return null;
      const before = org.enabledModules;
      const after = enabled ? [...new Set([...before, module])] : before.filter((m) => m !== module);
      if (after.length === before.length && after.every((m) => before.includes(m))) return { modules: before, changed: false };
      await tx.organization.update({ where: { id: orgId }, data: { enabledModules: after } });
      await tx.auditLog.create({
        data: {
          organizationId: orgId,
          userId: session.user.id ?? null,
          action: enabled ? "MODULE_ENABLED" : "MODULE_DISABLED",
          entityType: "Organization",
          entityId: orgId,
          changes: { module, before, after, source: "rest" },
        },
      });
      return { modules: after, changed: true };
    }));
    if (!result) {
      apiLogger.warn({ msg: "organizations-modules:org-not-found", orgId });
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }
    forgetOrgModules(orgId);
    apiLogger.info({ msg: "organizations-modules:updated", orgId, module, enabled, changed: result.changed, userId: session.user.id });
    return NextResponse.json({ enabledModules: result.modules });
  } catch (err) {
    apiLogger.error({ msg: "organizations-modules:update-failed", orgId, module, err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "Could not update the organisation's modules" }, { status: 500 });
  }
}
