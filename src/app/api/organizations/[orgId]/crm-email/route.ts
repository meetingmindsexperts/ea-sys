import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { denyNonOperator } from "@/lib/platform-operator";
import { db, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { claimsEnvironmentAddress, crmEmailSettingsSchema, readCrmEmailSettings, resolveIdentity } from "@/lib/crm-email-identity";

/**
 * GET / PUT /api/organizations/[orgId]/crm-email: one organisation's CRM email
 * identity (crm-email-identity.ts): its From, the mailbox replies are copied
 * to, its reply domain and its capture address.
 *
 * PLATFORM OPERATOR ONLY. Every one of these is tied to infrastructure the
 * operator runs (an SES-verified sender, an SES receipt rule, a mailbox rule),
 * and a tenant able to name its own capture address could claim another's.
 * Body `null` clears the block (the organisation then falls back to nothing,
 * or to the environment if it is the environment's organisation).
 */
const bodySchema = z.object({ crmEmail: crmEmailSettingsSchema.nullable() });

export async function GET(_req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const [session, { orgId }] = await Promise.all([auth(), params]);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyNonOperator(session, { route: "organizations/[orgId]/crm-email:GET" });
  if (denied) return denied;

  const org = await db.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  if (!org) {
    apiLogger.warn({ msg: "organizations-crm-email:org-not-found", orgId });
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }
  const identity = resolveIdentity(orgId, org.settings);
  return NextResponse.json({ crmEmail: readCrmEmailSettings(org.settings, orgId), effective: identity });
}

export async function PUT(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const [session, { orgId }] = await Promise.all([auth(), params]);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyNonOperator(session, { route: "organizations/[orgId]/crm-email:PUT" });
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    apiLogger.warn({ msg: "organizations-crm-email:invalid-body", orgId, errors: parsed.error.flatten().fieldErrors });
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  }
  const next = parsed.data.crmEmail;

  try {
    // A capture address belongs to exactly one organisation, or the worker could not tell whose mail it is.
    if (next?.captureAddress && claimsEnvironmentAddress(orgId, next.captureAddress)) {
      apiLogger.warn({ msg: "organizations-crm-email:env-capture-address", orgId });
      return NextResponse.json({ error: "That capture address belongs to this deployment's own organisation", code: "CAPTURE_ADDRESS_TAKEN" }, { status: 409 });
    }
    if (next?.captureAddress) {
      const taken = await db.organization.findFirst({
        where: { id: { not: orgId }, settings: { path: ["crmEmail", "captureAddress"], equals: next.captureAddress } },
        select: { id: true },
      });
      if (taken) {
        apiLogger.warn({ msg: "organizations-crm-email:capture-address-taken", orgId, takenBy: taken.id });
        return NextResponse.json({ error: "Another organisation already uses that capture address", code: "CAPTURE_ADDRESS_TAKEN" }, { status: 409 });
      }
    }

    const result = await runWithTenant(orgId, () =>
      tenantTransaction(async (tx) => {
        const org = await tx.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
        if (!org) return null;
        const before = readCrmEmailSettings(org.settings, orgId);
        // One key changed in place: never a read-modify-write of the whole settings blob.
        if (next) {
          await tx.$executeRaw`UPDATE "Organization" SET "settings" = jsonb_set(CASE WHEN jsonb_typeof("settings") = 'object' THEN "settings" ELSE '{}'::jsonb END, '{crmEmail}', ${JSON.stringify(next)}::jsonb), "updatedAt" = NOW() WHERE "id" = ${orgId}`;
        } else {
          await tx.$executeRaw`UPDATE "Organization" SET "settings" = (CASE WHEN jsonb_typeof("settings") = 'object' THEN "settings" ELSE '{}'::jsonb END) - 'crmEmail', "updatedAt" = NOW() WHERE "id" = ${orgId}`;
        }
        await tx.auditLog.create({
          data: {
            organizationId: orgId,
            userId: session.user.id ?? null,
            action: next ? "CRM_EMAIL_IDENTITY_SET" : "CRM_EMAIL_IDENTITY_CLEARED",
            entityType: "Organization",
            entityId: orgId,
            changes: { before, after: next, source: "rest" },
          },
        });
        return { settings: next };
      }),
    );
    if (!result) {
      apiLogger.warn({ msg: "organizations-crm-email:org-not-found", orgId });
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }
    apiLogger.info({ msg: "organizations-crm-email:updated", orgId, cleared: !next, userId: session.user.id });
    return NextResponse.json({ crmEmail: next });
  } catch (err) {
    apiLogger.error({ msg: "organizations-crm-email:update-failed", orgId, err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "Could not save the CRM email settings" }, { status: 500 });
  }
}
