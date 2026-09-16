import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { setPermissionSetArchived, updatePermissionSet } from "@/lib/permissions/permission-set-service";
import { denyNonRoleAdmin, permissionSetErrorResponse } from "@/lib/permissions/route-guard";

/**
 * Edit, archive or restore one custom role.
 *
 * THERE IS NO DELETE, deliberately. A role that people held explains past
 * approvals and past purchases; removing the row would leave an audit trail
 * naming an id that resolves to nothing. Archiving withdraws the access from
 * everyone holding it at once, which is the operation an admin actually wants.
 *
 * `expectedVersion` is required on an edit and is the optimistic lock: two
 * admins editing the same role cannot both commit and leave one edit invisible.
 * Archiving does not take one — it is a single deliberate toggle, not a form.
 */

const patchSchema = z
  .object({
    expectedVersion: z.number().int().min(1).optional(),
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(1000).nullable().optional(),
    permissions: z.array(z.string().max(100)).min(1).max(100).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => v.archived !== undefined || v.expectedVersion !== undefined, {
    message: "An edit must carry expectedVersion.",
    path: ["expectedVersion"],
  });

interface RouteParams {
  params: Promise<{ permissionSetId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [{ permissionSetId }, session, body] = await Promise.all([params, auth(), req.json()]);
    const denied = denyNonRoleAdmin(session, "permission-sets:PATCH");
    if (denied) return denied;

    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "permissions:patch-validation-failed", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const orgId = session!.user.organizationId!;
    const actorUserId = session!.user.id;
    const ip = getClientIp(req);
    const { archived, expectedVersion, name, description, permissions } = parsed.data;

    return await runWithTenant(orgId, async () => {
      // Archiving is its own operation rather than a field on the edit: it
      // changes who can do what for every holder, so it is never a side effect
      // of renaming something.
      if (archived !== undefined) {
        const result = await setPermissionSetArchived({
          organizationId: orgId,
          actorUserId,
          permissionSetId,
          archived,
          ip,
        });
        if (!result.ok) return permissionSetErrorResponse(result);
        return NextResponse.json({ ...result.set, holderCount: result.holderCount ?? 0 });
      }

      const result = await updatePermissionSet({
        organizationId: orgId,
        actorUserId,
        permissionSetId,
        expectedVersion: expectedVersion!,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(permissions !== undefined ? { permissions } : {}),
        ip,
      });
      if (!result.ok) return permissionSetErrorResponse(result);
      return NextResponse.json(result.set);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "permissions:update-failed" });
    return NextResponse.json({ error: "Failed to save the role" }, { status: 500 });
  }
}
