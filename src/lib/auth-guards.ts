import { NextResponse } from "next/server";
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
const RESTRICTED_WRITE_ROLES = ["REVIEWER", "SUBMITTER", "REGISTRANT", "MEMBER", "ONSITE", "CRM_USER"];

/**
 * Roles permitted to operate the REGISTRATION DESK — create a registration,
 * check attendees in, edit a registration, record a payment, print badges.
 * MEMBER + ONSITE are otherwise restricted from writes, so the registration-
 * domain write routes opt them back in via `denyReviewer(session, { allow:
 * REGISTRATION_DESK_ALLOW })`. Deliberately NOT including: deleting a
 * registration, bulk operations, or any non-registration domain — those stay
 * admin/organizer-only.
 */
export const REGISTRATION_DESK_ALLOW = ["ONSITE", "MEMBER"] as const;

/**
 * Org-bound "team member" roles — the ones shown under Settings → Users and
 * assignable via invite. REGISTRANT/SUBMITTER/REVIEWER are org-relationship
 * roles (an internal registrant can be org-bound but is NOT a team member),
 * so they're excluded.
 */
export const TEAM_ROLES = ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER", "ONSITE", "CRM_USER"] as const;

/** True when a role is an org team-member role (vs an attendee/reviewer role). */
export function isTeamRole(role: string | null | undefined): boolean {
  return !!role && (TEAM_ROLES as readonly string[]).includes(role);
}

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
 */
export function denyReviewer(
  session: { user?: { id?: string; role?: string } } | null,
  opts?: { allow?: readonly string[] },
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
export function denyFinance(session: { user?: { id?: string; role?: string } } | null) {
  if (!canViewFinance(session?.user?.role)) {
    // Logged HERE so no call site can forget (payments review M12).
    apiLogger.warn({
      msg: "auth-guard:finance-denied",
      role: session?.user?.role ?? null,
      userId: session?.user?.id ?? null,
    });
    return NextResponse.json(
      { error: "Financial data is not available to your role", code: "FINANCE_FORBIDDEN" },
      { status: 403 },
    );
  }
  return null;
}
