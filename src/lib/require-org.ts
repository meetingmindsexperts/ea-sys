import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";

/**
 * Guard the `organizationId!` footgun in one place.
 *
 * THE BUG IT PREVENTS
 * -------------------
 * Org-independent roles (REVIEWER / SUBMITTER / REGISTRANT) have
 * `User.organizationId === null`. A route that assumes an org and writes
 * `where: { id, organizationId: session.user.organizationId! }` sends
 * `organizationId: null` to Prisma — which is a *validation error* on the
 * non-nullable `Event.organizationId` column ("Argument `organizationId` must
 * not be null"), surfacing as a 500. That is Sentry JAVASCRIPT-NEXTJS-1N
 * (sponsors) / zoom:settings-fetch-failed and the whole `organizationId!` class
 * the multi-tenancy audit flagged (docs/MULTI_TENANCY_IMPACT.md §2.2).
 *
 * USAGE (session-auth routes) — after the `!session?.user` check, and after any
 * `denyReviewer(session)` write guard:
 *
 *     const org = requireOrgId(session, { route: "sponsors:list", eventId });
 *     if ("error" in org) return org.error;
 *     // ...use org.orgId (a plain string) instead of session.user.organizationId!
 *
 * Returns a 403 (an org-independent user has no business on an org-admin route)
 * and warn-logs who hit it, so a real ADMIN/ORGANIZER surfacing here — which
 * would mean a session lost its org, a deeper bug — is visible in /logs.
 *
 * NOTE: routes that legitimately serve org-independent users (submitter /
 * reviewer abstract flows) must NOT use this — they scope via
 * buildEventAccessWhere instead. This is only for org-admin routes.
 */
export function requireOrgId(
  session: { user?: { id?: string; role?: string; organizationId?: string | null } } | null | undefined,
  ctx?: { route?: string; eventId?: string },
): { orgId: string } | { error: NextResponse } {
  const orgId = session?.user?.organizationId;
  if (!orgId) {
    apiLogger.warn(
      { userId: session?.user?.id, role: session?.user?.role, ...ctx },
      "require-org:no-org",
    );
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { orgId };
}
