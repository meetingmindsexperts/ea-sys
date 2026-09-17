import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { readPermissionSetHolderCounts } from "@/lib/permissions/permission-set-service";
import { denyNonRoleAdmin } from "@/lib/permissions/route-guard";

/**
 * Who holds a custom role, as a count per person, for Settings -> Team.
 *
 * WHY THIS EXISTS RATHER THAN A FIELD ON /api/organization/users. That list is
 * what Settings already renders, so a relation select there looks like the
 * obvious answer. It is the wrong one twice over: `UserPermissionSet` is
 * RLS-policied and that route opens NO tenant lane, so the select would read
 * correctly here and return ZERO on the platform, putting every role holder
 * back to looking like nobody with nothing failing; and wrapping that route to
 * fix it would hold a lane across its POST's bcrypt hashing and outbound
 * invitation email, which is precisely what check-tenant-als.sh's own note asks
 * that directory to avoid. One small lane-wrapped read is the cheaper correct
 * answer, and it lives beside the other permission-set routes that are already
 * swept.
 */
export async function GET() {
  try {
    const session = await auth();
    const denied = denyNonRoleAdmin(session, "permission-set-holders:GET");
    if (denied) return denied;

    const orgId = session!.user.organizationId!; // captured before the closure
    return await runWithTenant(orgId, async () =>
      NextResponse.json(await readPermissionSetHolderCounts(orgId)),
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "permissions:holder-counts-failed" });
    return NextResponse.json({ error: "Failed to load who holds a role" }, { status: 500 });
  }
}
