/**
 * PLATFORM OPERATOR: the RBAC wall that sits beside the privileged database
 * lane (`dbOperator` in src/lib/db.ts).
 *
 * Multi-tenancy item 5, owner decision Aug 11 2026 (docs/PLATFORM_DECISIONS.md
 * §5b): the platform operator is **SUPER_ADMIN**. No new role was minted:
 * reusing the existing one costs no migration, and the operator surface is a
 * handful of read routes rather than a job function.
 *
 * WHY THIS IS ITS OWN PREDICATE, AND NOT ONE OF THE EXISTING SIX.
 * `AGENTS.md` records six visibility boundaries that deliberately disagree
 * (finance includes MEMBER, barcode excludes it, contacts excludes ONSITE, …).
 * This is the seventh, and it is narrower than every one of them:
 *
 *   - `denyReviewer` is a WRITE guard that lets ADMIN and ORGANIZER through.
 *   - `canViewFinance` includes MEMBER and ONSITE.
 *   - Even the tightest existing read boundary is org-scoped by construction.
 *
 * This one answers a different question entirely: *may this caller read across
 * tenant boundaries?* Reaching for a close-enough existing predicate is the
 * exact mistake that produced four of the others, so this gets its own.
 *
 * ⚠ API KEYS ARE DELIBERATELY EXCLUDED. Everywhere else in this codebase an
 * org API key is treated as admin-equivalent (`getOrgContext` returns
 * `role: null` and the MCP surface trusts it). That equivalence stops here: a
 * key belongs to ONE tenant, and tenants must never reach the cross-tenant
 * lane. A null/absent role therefore fails closed, like every unknown role.
 *
 * ⚠ TWO WALLS. Passing this check does not put the caller on the privileged
 * DB lane, and using `dbOperator` does not authorize the caller. A route doing
 * cross-tenant work needs BOTH. Neither substitutes for the other: the DB lane
 * without this guard is an open cross-tenant read; this guard without the DB
 * lane silently returns zero rows under platform RLS.
 */

import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";

/**
 * May this user act as the platform operator (read/act across tenants)?
 *
 * TWO conditions, and the second only exists on the platform:
 *   1. the role is SUPER_ADMIN, and
 *   2. IF `PLATFORM_ORG_ID` is set, the user belongs to that org.
 *
 * Condition 2 was added Aug 11, 2026 after review. Without it "SUPER_ADMIN" is
 * unqualified, so a SUPER_ADMIN row belonging to any TENANT would be a platform
 * operator and could read every tenant's captured help-chat questions and
 * business counters. `ASSIGNABLE_USER_ROLES` excludes SUPER_ADMIN so the role
 * cannot be granted through the admin UI today, but that is a property of one
 * screen, not an invariant, and the tenant-onboarding flow does not exist yet
 * to inherit it.
 *
 * `PLATFORM_ORG_ID` is the synthetic operator org decided in
 * PLATFORM_DECISIONS §3. It is UNSET on master, where condition 2 is skipped
 * and behaviour is exactly as before: MMG's SUPER_ADMIN stays the operator.
 * Fails closed on unknown, absent and API-key (`null`) roles.
 */
export function canActAsPlatformOperator(
  user: { role?: string | null; organizationId?: string | null } | null | undefined,
): boolean {
  if (user?.role !== "SUPER_ADMIN") return false;
  const platformOrgId = process.env.PLATFORM_ORG_ID;
  if (!platformOrgId) return true;
  return user.organizationId === platformOrgId;
}

/**
 * Returns a 403 if the session cannot act as the platform operator, else null.
 *
 * Pair this with `dbOperator` on every cross-tenant HTTP surface:
 *
 *   const denied = denyNonOperator(session, { route: "help-chat:queries" });
 *   if (denied) return denied;
 *   const rows = await dbOperator.helpChatQuery.findMany({ … });
 *
 * The refusal is logged HERE so no call site can forget, same reasoning as
 * `denyReviewer`/`denyFinance`, and the same `{ route }` shape so all three
 * read alike in /logs. Pass `route` always: this guard protects the widest
 * reads in the system, so an unexplained refusal is the one you least want to
 * have to place by grepping.
 */
export function denyNonOperator(
  session: { user?: { id?: string; role?: string; organizationId?: string | null } } | null,
  ctx?: { route?: string },
) {
  if (canActAsPlatformOperator(session?.user)) return null;

  apiLogger.warn({
    msg: "platform-operator:denied",
    role: session?.user?.role ?? null,
    userId: session?.user?.id ?? null,
    ...(ctx?.route ? { route: ctx.route } : {}),
  });
  return NextResponse.json(
    { error: "Forbidden", code: "OPERATOR_ONLY" },
    { status: 403 },
  );
}

/**
 * Resolve which organisation a request is acting on, honouring the `x-org-id`
 * override ONLY for a genuine platform operator.
 *
 * WHY THIS EXISTS (found by the Aug 21 2026 ADMIN-gate sweep)
 * -----------------------------------------------------------
 * Six call sites read `x-org-id` and swapped the acting org on nothing more
 * than `role === "SUPER_ADMIN"`. That is correct in single-org mode, where
 * SUPER_ADMIN means an MMG employee and the header is just the org switcher in
 * `use-api.ts`. On the platform it means a customer's own SUPER_ADMIN could
 * read — and through `PUT /api/organization`, WRITE — any other tenant's
 * organisation by setting one header.
 *
 * This one is a different and worse shape than the five defects the tenancy
 * rehearsal found. Those all failed CLOSED: no lane, RLS matches nothing, an
 * empty screen. This fails OPEN. The overridden id is used directly, so a
 * later `runWithTenant(orgId)` enters the TARGET tenant's lane and RLS serves
 * their rows faithfully. RLS is not a backstop against a caller who has been
 * handed the wrong tenant id; it is an accomplice.
 *
 * MASTER IS UNAFFECTED. `PLATFORM_ORG_ID` is unset there, so
 * `canActAsPlatformOperator` reduces to the previous `role === "SUPER_ADMIN"`
 * test and the org switcher keeps working exactly as before.
 *
 * Both outcomes are logged, deliberately at different levels: an honoured
 * override is a cross-tenant action and must be traceable (info); a REFUSED
 * one is an attempt to reach another tenant and is a security event (warn).
 * The no-op case — header present but naming the caller's own org, which the
 * switcher does routinely — is silent, so the warn stays meaningful.
 */
export function resolveActingOrgId(
  req: Request,
  user: { id?: string; role?: string | null; organizationId?: string | null } | null | undefined,
  ownOrgId: string,
  ctx?: { route?: string },
): string {
  const requested = req.headers.get("x-org-id");
  if (!requested || requested === ownOrgId) return ownOrgId;

  if (!canActAsPlatformOperator(user)) {
    apiLogger.warn({
      msg: "platform-operator:org-override-refused",
      role: user?.role ?? null,
      userId: user?.id ?? null,
      ownOrgId,
      requestedOrgId: requested,
      ...(ctx?.route ? { route: ctx.route } : {}),
    });
    return ownOrgId;
  }

  apiLogger.info({
    msg: "platform-operator:org-override",
    userId: user?.id ?? null,
    ownOrgId,
    actingOrgId: requested,
    ...(ctx?.route ? { route: ctx.route } : {}),
  });
  return requested;
}
