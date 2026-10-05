import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { firstGrantBeyondActor } from "@/lib/permissions/escalation";
import type { PermissionKey } from "@/lib/permissions/catalogue";

/**
 * The roles an API key may act with (custom roles Phase 5), for the key form.
 * Gated by `apiKeys.manage`, not `roles.manage`: the person minting keys
 * picks a role, they do not edit one. `usable` is false for a role wider than
 * the caller, which the create route would refuse.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "apiKeys.manage", { route: "organization/api-keys/roles:GET" });
    if (!gate.ok) return gate.response;

    const roles = await db.permissionSet.findMany({
      where: { organizationId: session.user.organizationId!, archivedAt: null, isSystem: false },
      select: { id: true, name: true, description: true, permissions: { select: { permission: true, scope: true } } },
      orderBy: { name: "asc" },
    });
    return NextResponse.json(
      roles.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        usable: firstGrantBeyondActor(gate.principal, r.permissions.map((p) => ({ permission: p.permission as PermissionKey, scope: p.scope }))) === null,
      })),
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "organization/api-keys/roles:list-failed" });
    return NextResponse.json({ error: "Failed to list roles" }, { status: 500 });
  }
}
