import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import type { Session } from "next-auth";

/**
 * Resolves the effective organization ID for the current request.
 *
 * For SUPER_ADMIN: respects `x-org-id` header to switch orgs.
 * For all other roles: returns session.user.organizationId.
 *
 * Validates that the target org exists when an override is used.
 */
export async function getEffectiveOrgId(req?: Request): Promise<{
  orgId: string | null;
  session: Session | null;
}> {
  const session = await auth() as Session | null;
  if (!session?.user) return { orgId: null, session };

  const sessionOrgId = session.user.organizationId ?? null;

  // Only SUPER_ADMIN can override
  if (session.user.role === "SUPER_ADMIN" && req) {
    const overrideOrgId = req.headers.get("x-org-id");
    if (overrideOrgId && overrideOrgId !== sessionOrgId) {
      // Validate the org exists
      const org = await db.organization.findUnique({
        where: { id: overrideOrgId },
        select: { id: true },
      });
      if (org) {
        return { orgId: org.id, session };
      }
    }
  }

  return { orgId: sessionOrgId, session };
}
