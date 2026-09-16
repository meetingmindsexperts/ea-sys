import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { isTeamRole } from "@/lib/team-roles";
import { runWithTenant } from "@/lib/tenant-context";
import { readUserPermissionSetIds, setUserPermissionSets } from "@/lib/permissions/permission-set-service";
import { denyNonRoleAdmin, permissionSetErrorResponse } from "@/lib/permissions/route-guard";

/**
 * The roles tagged on ONE person (plan §6, Settings → Users).
 *
 * PUT is replace-all: the dialog shows every role with a tick box, so what it
 * sends IS the answer. A diff-shaped API would let a tab left open re-add a
 * role the admin had just taken away.
 *
 * The AED approval limit is NOT set here. It stays on the person and moves
 * through the users PUT beside the other grants (D3): two people holding the
 * same "PO Approver" role approve to different amounts, so the authority cannot
 * live on the role.
 */

const putSchema = z.object({
  permissionSetIds: z.array(z.string().min(1).max(100)).max(50),
});

interface RouteParams {
  params: Promise<{ userId: string }>;
}

/** Roles may only be tagged on staff — the same rule the other grants follow. */
async function loadTeamMember(userId: string, organizationId: string) {
  const user = await db.user.findFirst({
    where: { id: userId, organizationId },
    select: { id: true, role: true },
  });
  if (!user || !isTeamRole(user.role)) return null;
  return user;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ userId }, session] = await Promise.all([params, auth()]);
    const denied = denyNonRoleAdmin(session, "user-permission-sets:GET");
    if (denied) return denied;

    const orgId = session!.user.organizationId!;
    return await runWithTenant(orgId, async () => {
      const user = await loadTeamMember(userId, orgId);
      if (!user) {
        apiLogger.warn({ msg: "permissions:assignment-target-not-team", targetUserId: userId });
        return NextResponse.json({ error: "Team member not found" }, { status: 404 });
      }
      const permissionSetIds = await readUserPermissionSetIds(orgId, userId);
      return NextResponse.json({ permissionSetIds });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "permissions:read-assignment-failed" });
    return NextResponse.json({ error: "Failed to load this person's roles" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ userId }, session, body] = await Promise.all([params, auth(), req.json()]);
    const denied = denyNonRoleAdmin(session, "user-permission-sets:PUT");
    if (denied) return denied;

    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "permissions:assignment-validation-failed", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const orgId = session!.user.organizationId!;
    const actorUserId = session!.user.id;
    const ip = getClientIp(req);

    return await runWithTenant(orgId, async () => {
      const user = await loadTeamMember(userId, orgId);
      if (!user) {
        apiLogger.warn({ msg: "permissions:assignment-target-not-team", targetUserId: userId });
        return NextResponse.json({ error: "Team member not found" }, { status: 404 });
      }
      const result = await setUserPermissionSets({
        organizationId: orgId,
        actorUserId,
        userId,
        permissionSetIds: parsed.data.permissionSetIds,
        ip,
      });
      if (!result.ok) return permissionSetErrorResponse(result);
      return NextResponse.json(result);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "permissions:assignment-failed" });
    return NextResponse.json({ error: "Failed to save this person's roles" }, { status: 500 });
  }
}
