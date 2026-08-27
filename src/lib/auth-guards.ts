import { NextResponse } from "next/server";
import { TEAM_ROLES } from "@/lib/team-roles";
import { canViewFinance } from "@/lib/finance-visibility";
import { apiLogger } from "@/lib/logger";

/**
 * Roles with no general write access. By default every POST/PUT/DELETE on a
 * non-abstract resource is blocked for these. ONSITE (registration-desk staff)
 * is in this set too — it is allowed ONLY on the specific create-registration,
 * check-in, and badge-print routes, which opt it back in via `opts.allow`.
 */
// CRM_USER is restricted from writes on the general (non-CRM) routes — it can only
// write inside /api/crm/* (which gate via requireCrmWrite → canOwnDeals, not this).
// WEBINARS (webinar team, Aug 3 2026) is restricted by DEFAULT too — its full
// control of WEBINAR-type events is opt-in per route via WEBINAR_STAFF_ALLOW,
// always paired with a buildEventAccessWhere lookup (which resolves ONLY
// webinar events for this role), so a missed route fails closed.
// ⚠ THIS IS THE ONLY DENY-LIST AMONG THE ROLE PREDICATES. Every other one
// (finance, barcode, contacts, login, export, operator, hr) is an allow-list, so
// a new role is excluded from them for free. Here, a role that is ABSENT can
// write to every non-HR, non-CRM route in the application. Adding a confined
// role and forgetting this line is the single highest-consequence omission in
// the RBAC surface, and nothing else fails loudly if you make it.
const RESTRICTED_WRITE_ROLES = ["REVIEWER", "SUBMITTER", "REGISTRANT", "MEMBER", "ONSITE", "CRM_USER", "WEBINARS", "HR_USER"];

/**
 * Roles permitted to operate the REGISTRATION DESK — create a registration,
 * check attendees in, edit a registration, record a payment, print badges.
 * MEMBER + ONSITE (+ WEBINARS, which since Aug 10, 2026 carries these desk
 * powers on EVERY event in its org — MEMBER parity, it is internal staff) are
 * otherwise restricted from writes, so the
 * registration-domain write routes opt them back in via
 * `denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW })`. Deliberately
 * NOT including: deleting a registration, bulk operations, or any
 * non-registration domain — those stay admin/organizer-only (WEBINARS gets
 * them on WEBINAR events only, via WEBINAR_STAFF_ALLOW + the access where).
 */
export const REGISTRATION_DESK_ALLOW = ["ONSITE", "MEMBER", "WEBINARS"] as const;

/**
 * The WEBINARS role's full-control opt-in (Aug 3, 2026). Routes in the
 * webinar-relevant modules (webinar console, sessions/agenda, communications,
 * registrations, speakers, tickets, media, sponsors, survey, event PUT/create)
 * pass this so the webinar team can run webinar events end-to-end.
 *
 * INVARIANT — every route that opts WEBINARS in via this list MUST resolve
 * its event through `buildEventAccessWhere` (default / "manage" surface), which
 * for WEBINARS matches ONLY `eventType: WEBINAR` events in its org. That pairing
 * is what confines the role: the guard says "this OPERATION is allowed", the
 * where says "…but only on a webinar". An org-scoped hand-rolled event lookup
 * next to this allow would open the operation on conferences — never do that.
 *
 * The invariant got MORE load-bearing on Aug 10, 2026, when the DESK surface
 * went org-wide for this role (MEMBER parity). The manage surface deliberately
 * did not follow, and must not: ~55 route files sit behind this allow, so
 * widening the default would open all of them on conferences in one edit.
 * `webinars-role-isolation.test.ts` fails if anyone tries — mutation-verified
 * against that exact change.
 *
 * Related trap, same family: do NOT write `orgCtx ? { id, organizationId } :
 * buildEventAccessWhere(...)`. It reads as "an API key, else a person" but
 * `getOrgContext()` matches a signed-in person too, so the role scoping never
 * runs. Use `accessUserFrom` — see its docblock for the live bypass that shape
 * produced.
 */
export const WEBINAR_STAFF_ALLOW = ["WEBINARS"] as const;

/**
 * Org-bound "team member" roles — the ones shown under Settings → Users and
 * assignable via invite. REGISTRANT/SUBMITTER/REVIEWER are org-relationship
 * roles (an internal registrant can be org-bound but is NOT a team member),
 * so they're excluded.
 *
 * DECLARED in `team-roles.ts` and re-exported here. That module has no server
 * imports, so a client component can ask "is this person staff?" without
 * dragging `next/server` and the logger into the browser bundle. Import from
 * either place; there is one list.
 */
export { TEAM_ROLES, isTeamRole } from "@/lib/team-roles";

/**
 * Roles an org admin may ASSIGN — when inviting a new team member, and when
 * changing an existing member's role. Both doors derive from this list.
 *
 * They previously kept SEPARATE hand-written lists, and the change-role door
 * silently fell four roles behind: inviting someone AS Webinars worked, while
 * moving an existing person TO Webinars failed validation. The type check
 * below makes that impossible to repeat — adding a role to TEAM_ROLES without
 * making it assignable fails the build.
 *
 * SUPER_ADMIN is deliberately EXCLUDED: it must never be grantable through an
 * ordinary admin surface. REVIEWER is included despite not being a team role —
 * reviewers are org-independent, but are invited and promoted through this
 * same door (see the Reviewers page).
 */
export const ASSIGNABLE_USER_ROLES = [
  "ADMIN",
  "ORGANIZER",
  "MEMBER",
  "ONSITE",
  "CRM_USER",
  "WEBINARS",
  "HR_USER",
  "REVIEWER",
] as const;

export type AssignableUserRole = (typeof ASSIGNABLE_USER_ROLES)[number];

// Compile-time guard: every team role except SUPER_ADMIN must be assignable.
// A new role added to TEAM_ROLES and forgotten here breaks the build rather
// than silently becoming un-assignable from the change-role dialog.
type _AssignableCoversTeamRoles =
  Exclude<(typeof TEAM_ROLES)[number], "SUPER_ADMIN"> extends AssignableUserRole
    ? true
    : { error: "ASSIGNABLE_USER_ROLES is missing a team role" };
const _assignableCoversTeamRoles: _AssignableCoversTeamRoles = true;
void _assignableCoversTeamRoles;


/**
 * Returns a 403 Forbidden response if the user has a restricted role
 * (REVIEWER, SUBMITTER, REGISTRANT, MEMBER, or ONSITE).
 * These roles are only allowed limited operations — all other
 * write operations (POST, PUT, DELETE) on non-abstract resources must
 * call this guard before proceeding.
 *
 * Pass `opts.allow` to let a specific restricted role through on a route it is
 * permitted to write (e.g. ONSITE on registration-create / check-in / badges).
 *
 * Usage:
 *   const denied = denyReviewer(session);                        // block all restricted
 *   const denied = denyReviewer(session, { allow: ["ONSITE"] }); // …but let ONSITE write here
 *   if (denied) return denied;
 *
 * `route` IS REQUIRED. The refusal is logged here, and without it the line
 * records WHO was refused but not WHAT they were refused:
 *
 *   denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW, route: "tags:POST", eventId })
 *
 * Same `{ route, eventId }` shape as requireOrgId, deliberately, so the two
 * read alike in /logs. Label format is the API path with the HTTP method,
 * `events/[eventId]/speakers:POST`, which is derivable from the file so it
 * cannot be wrong or go stale. A per-file gate helper shared by several verbs
 * uses `:gate` instead of a method.
 *
 * WHY REQUIRED, reversing the earlier note here (Aug 25, 2026). That note said
 * most call sites "do not need to: a route no restricted role can reach never
 * logs", and to add it only when touching a route that can. The argument has a
 * hole: it assumes you already know which routes a restricted role can reach,
 * and being WRONG about that is the whole bug class.
 *
 * On Aug 24 the abstract-reviewers GET turned out to be reachable by MEMBER and
 * ONSITE, which nobody had thought possible, and tracing it meant grepping a
 * page's React hooks to work out which endpoint had refused. On Aug 10, 51
 * warnings in three hours cost the same five-step deduction. Both are cases
 * where the route was believed unreachable, so under the old rule neither
 * would have carried a label.
 *
 * Optional meant 3 of 226 sites passed it. Required means the compiler asks,
 * once, at the only moment anyone knows the answer.
 */
export function denyReviewer(
  session: { user?: { id?: string; role?: string } } | null,
  opts: { allow?: readonly string[]; route: string; eventId?: string },
) {
  const role = session?.user?.role;
  if (role && RESTRICTED_WRITE_ROLES.includes(role) && !opts?.allow?.includes(role)) {
    // Logged HERE so no call site can forget (payments review M12): a
    // restricted role probing write endpoints must be visible in /logs.
    apiLogger.warn({
      msg: "auth-guard:write-denied",
      role,
      userId: session?.user?.id ?? null,
      allow: opts?.allow ?? null,
      // `route` is optional and unset on most call sites. Pass it on any route
      // a restricted role can actually REACH — without it the warn line names
      // who was refused but not what they were refused, and triage becomes
      // "grep the page's hooks and infer" (Aug 10, 2026: 51 warns in 3h took a
      // five-step deduction to place). See the docblock note above.
      ...(opts?.route ? { route: opts.route } : {}),
      ...(opts?.eventId ? { eventId: opts.eventId } : {}),
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * Returns a 403 if the session's role cannot view financial data.
 * `denyReviewer` covers write routes; this covers finance-data GET
 * routes (invoice list/detail/PDF/send, quote + document PDFs) which
 * are reads — denyReviewer would let MEMBER through since GETs aren't
 * blocked there. MEMBER is the org-bound read-only viewer that is
 * specifically barred from money.
 *
 * Usage (after auth + event-access check):
 *   const noFinance = denyFinance(session);
 *   if (noFinance) return noFinance;
 */
export function denyFinance(
  session: { user?: { id?: string; role?: string } } | null,
  ctx: { route: string; eventId?: string },
) {
  if (!canViewFinance(session?.user?.role)) {
    // Logged HERE so no call site can forget (payments review M12).
    // `route` required, same reasoning as denyReviewer above.
    apiLogger.warn({
      msg: "auth-guard:finance-denied",
      role: session?.user?.role ?? null,
      userId: session?.user?.id ?? null,
      ...(ctx?.route ? { route: ctx.route } : {}),
      ...(ctx?.eventId ? { eventId: ctx.eventId } : {}),
    });
    return NextResponse.json(
      { error: "Financial data is not available to your role", code: "FINANCE_FORBIDDEN" },
      { status: 403 },
    );
  }
  return null;
}
