/**
 * Who may read the sign-in history.
 *
 * WHY ITS OWN BOUNDARY (the recurring lesson in this codebase — reaching for a
 * "close enough" existing predicate is the signal to write a new one):
 *
 *   - `denyReviewer` is a WRITE guard, and it permits ORGANIZER. Sign-in
 *     history is a read, and it spans the whole org's staff — an organizer
 *     running one conference has no business seeing when the finance admin
 *     last signed in or from which address.
 *   - `canViewFinance` includes MEMBER and ONSITE, both of which must not see
 *     this, and it answers an unrelated question.
 *   - `canExportRegistrations` happens to exclude MEMBER correctly today, but
 *     it includes ONSITE (desk staff) and answers "may you take the delegate
 *     book away".
 *
 * Sign-in records are security data about colleagues: IP address, approximate
 * location, and the times a named person was at their desk. That is a narrower
 * population than any existing predicate expresses, so: SUPER_ADMIN and ADMIN
 * only. Everyone else — including ORGANIZER — gets 403.
 *
 * There is deliberately NO API-key path. Every other org-scoped read accepts an
 * admin-minted key as admin-equivalent; this one does not, because a key that
 * leaks into an automation log would expose the movements of staff rather than
 * business records. If a genuine integration need appears, it should be its own
 * explicit grant rather than inherited by default.
 */

import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";

const LOGIN_ACTIVITY_ROLES = new Set(["SUPER_ADMIN", "ADMIN"]);

/** True when the caller may read sign-in history. Fails closed on an unknown role. */
export function canViewLoginActivity(role: string | null | undefined): boolean {
  return !!role && LOGIN_ACTIVITY_ROLES.has(role);
}

/**
 * Guard for the login-activity routes. Returns a 403 when the caller may not
 * read, else null.
 *
 * Logs its own refusal so no call site can forget to — a silent 403 on a
 * boundary protecting staff PII is exactly the thing not to be blind to.
 */
export function denyLoginActivity(ctx: {
  role: string | null | undefined;
  userId?: string | null;
  organizationId?: string | null;
}): NextResponse | null {
  if (canViewLoginActivity(ctx.role)) return null;

  apiLogger.warn({
    msg: "login-activity:forbidden",
    role: ctx.role ?? null,
    userId: ctx.userId ?? null,
    organizationId: ctx.organizationId ?? null,
  });

  return NextResponse.json(
    {
      error: "You don't have permission to view sign-in activity.",
      code: "LOGIN_ACTIVITY_FORBIDDEN",
    },
    { status: 403 },
  );
}
