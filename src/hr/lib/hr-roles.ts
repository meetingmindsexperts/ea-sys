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
 * The answer here is deliberately narrow: SUPER_ADMIN, HR_USER, and anyone
 * explicitly granted. Nobody else, in either direction.
 *
 * ⚠ ADMIN IS NOT ENOUGH ON ITS OWN (owner, Aug 31 2026). It used to be, and
 * that was this file's own warning coming true one level up: ADMIN means "runs
 * the events business" and has never meant "may read a colleague's sick leave",
 * so deriving one from the other made the population accidental rather than
 * chosen. There were three admins and only two of them belonged in here.
 *
 * The grant is now a per-person flag (`User.hrAccess`), ticked in
 * Settings → Users by a SUPER_ADMIN. It FAILS CLOSED in the direction that
 * matters: a newly hired admin, a promoted organiser and a restored backup all
 * start with no HR access, and somebody has to decide to give it. The previous
 * shape failed OPEN, which is how this came up at all.
 *
 * ⚠ API KEYS ARE EXCLUDED, like the platform-operator predicate and unlike
 * everywhere else in this codebase. `getOrgContext` returns `role: null` for a
 * key and the rest of the app treats that as admin-equivalent. That equivalence
 * stops here: an API key is not a person, HR data is about people, and a key
 * leaked into an integration should not be able to read who was off sick. A
 * null or unknown role fails closed, and the per-person grant cannot rescue it
 * either: a key has no user row, so it has no flag to carry.
 *
 * ⚠ AVAILABILITY IS A SEPARATE GATE. Passing this check does not mean the module
 * is switched on: `isHrModuleEnabled()` is checked first, and on a deployment
 * where HR is off every route 404s regardless of role. Two walls, neither
 * substituting for the other.
 */

import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { isHrModuleEnabled } from "@/lib/module-flags";
import { canViewHr, canWriteHr } from "./hr-visibility";

/*
 * The predicate itself lives in `hr-visibility.ts`, with no server-only
 * imports, so the sidebar can ask exactly the question this guard asks. It is
 * re-exported here because every existing caller imports it from this file and
 * one answer in two places is the whole point.
 */
export { canViewHr, canWriteHr, HR_SELF_SUFFICIENT_ROLES } from "./hr-visibility";

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
