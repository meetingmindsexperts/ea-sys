/**
 * HR VISIBILITY: who may read and write the HR module.
 *
 * WHY THIS IS ITS OWN PREDICATE, and not one of the nine that already exist.
 * `AGENTS.md` records a set of visibility boundaries that deliberately disagree
 * (finance includes MEMBER and ONSITE, barcode excludes MEMBER, contacts
 * excludes ONSITE, the operator predicate excludes API keys). Reaching for a
 * close-enough one is the mistake that produced several of them. None of them
 * has this shape:
 *
 *   - `denyReviewer` is a WRITE guard that lets ADMIN and ORGANIZER through, and
 *     an ORGANIZER has no business reading a colleague's sick leave.
 *   - `canViewFinance` includes MEMBER and ONSITE.
 *   - `isTeamRole` is every org employee, which is the population this excludes.
 *
 * The answer here is deliberately narrow: SUPER_ADMIN, ADMIN, HR_USER. Nobody
 * else, in either direction.
 *
 * ⚠ API KEYS ARE EXCLUDED, like the platform-operator predicate and unlike
 * everywhere else in this codebase. `getOrgContext` returns `role: null` for a
 * key and the rest of the app treats that as admin-equivalent. That equivalence
 * stops here: an API key is not a person, HR data is about people, and a key
 * leaked into an integration should not be able to read who was off sick. A
 * null or unknown role fails closed.
 *
 * ⚠ AVAILABILITY IS A SEPARATE GATE. Passing this check does not mean the module
 * is switched on: `isHrModuleEnabled()` is checked first, and on a deployment
 * where HR is off every route 404s regardless of role. Two walls, neither
 * substituting for the other.
 */

import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { isHrModuleEnabled } from "@/lib/module-flags";

const HR_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "HR_USER"]);

/** May this user see the HR module at all? Fails closed on unknown roles. */
export function canViewHr(
  user: { role?: string | null } | null | undefined,
): boolean {
  return !!user?.role && HR_ROLES.has(user.role);
}

/**
 * May this user change HR data?
 *
 * Currently identical to read access, and that is a decision rather than an
 * oversight: the module has exactly one operator (Muthu) plus admins, and a
 * read-only HR role has no described user. Kept as a separate function so the
 * day somebody wants an auditor who can look and not touch, the call sites are
 * already asking the right question.
 */
export function canWriteHr(
  user: { role?: string | null } | null | undefined,
): boolean {
  return canViewHr(user);
}

/**
 * The route guard. Returns a response to send, or null to continue.
 *
 * Returns **404, not 403**, when the module is switched off, because a module
 * that is not available on this deployment should not announce that it exists.
 * A caller who is merely unauthorised still gets 403, which is the honest answer
 * once we have admitted the module is here.
 *
 * The refusal is logged HERE so no call site can forget, same reasoning as
 * `denyReviewer` and `denyNonOperator`, and with the same `{ route }` shape so
 * all of them read alike in /logs. Pass `route` always.
 */
export function denyNonHr(
  session: { user?: { id?: string; role?: string | null } } | null | undefined,
  context: { route: string; write?: boolean },
): NextResponse | null {
  if (!isHrModuleEnabled()) {
    apiLogger.warn({
      msg: `${context.route}:hr-module-disabled`,
      userId: session?.user?.id ?? null,
    });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const allowed = context.write ? canWriteHr(session?.user) : canViewHr(session?.user);
  if (!allowed) {
    apiLogger.warn({
      msg: `${context.route}:hr-forbidden`,
      role: session?.user?.role ?? null,
      userId: session?.user?.id ?? null,
      write: context.write ?? false,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}
