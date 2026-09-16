import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import {
  createPermissionSet,
  ensureStarterPermissionSets,
  listPermissionSets,
} from "@/lib/permissions/permission-set-service";
import { denyNonRoleAdmin, permissionSetErrorResponse } from "@/lib/permissions/route-guard";

/**
 * Settings → Roles: the org's custom roles (plan §6).
 *
 * The GET SEEDS the four starter roles on first read, which is why this is the
 * only place `ensureStarterPermissionSets` is called: seeding on a read the
 * admin has just navigated to means the screen is never empty on a fresh
 * organisation, and the seeder's own "never re-seed an org that holds any role,
 * archived included" rule keeps that from undoing anybody's decision.
 */

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).nullable().optional(),
  permissions: z.array(z.string().max(100)).min(1).max(100),
});

export async function GET(req: Request) {
  try {
    const session = await auth();
    const denied = denyNonRoleAdmin(session, "permission-sets:GET");
    if (denied) return denied;

    const orgId = session!.user.organizationId!; // captured before the closure
    const includeArchived = new URL(req.url).searchParams.get("includeArchived") === "1";

    // Tenancy: the service reads swept models and deliberately opens no lane of
    // its own, so a wrapless call here would fail-closed to zero rows on the
    // platform and re-seed the starter roles on every request.
    return await runWithTenant(orgId, async () => {
      await ensureStarterPermissionSets(orgId);
      const sets = await listPermissionSets(orgId, { includeArchived });
      return NextResponse.json(sets);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "permissions:list-failed" });
    return NextResponse.json({ error: "Failed to load the roles" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json()]);
    const denied = denyNonRoleAdmin(session, "permission-sets:POST");
    if (denied) return denied;

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "permissions:create-validation-failed", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const orgId = session!.user.organizationId!;
    const actorUserId = session!.user.id;
    const ip = getClientIp(req);

    return await runWithTenant(orgId, async () => {
      const result = await createPermissionSet({
        organizationId: orgId,
        actorUserId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        permissions: parsed.data.permissions,
        ip,
      });
      if (!result.ok) return permissionSetErrorResponse(result);
      return NextResponse.json(result.set, { status: 201 });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "permissions:create-failed" });
    return NextResponse.json({ error: "Failed to create the role" }, { status: 500 });
  }
}
