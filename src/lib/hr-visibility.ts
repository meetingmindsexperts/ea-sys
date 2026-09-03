/**
 * WHO MAY SEE HR: the predicate, with no server-only imports.
 *
 * WHY THIS LIVES IN CORE AND NOT IN `src/hr/` (moved Sep 3, 2026). It started
 * in `src/hr/lib/hr-visibility.ts`, and the sidebar needed an eslint exemption
 * to import it. Then the org Activity page needed it too, for the HR tab and
 * the `?scope=hr` audit query, which would have made three exemptions for one
 * pure function. A growing exemption list is the signal that a file is on the
 * wrong side of a boundary, the same reasoning that moved `module-flags.ts`.
 * The question "may this person see HR data" is one CORE has to ask in a few
 * places (a nav entry, an audit feed), so core owns the answer. `src/hr/` keeps
 * a re-export so nothing inside the module changed its import.
 *
 * Split out of `hr-roles.ts` in the first place so the SIDEBAR could ask the
 * same question the route guard asks. `hr-roles.ts` imports `next/server` and
 * the pino logger, and importing either into a `"use client"` component
 * bundles them as `undefined`: the build passes, the tests pass, and the thing
 * silently misbehaves in the browser. Same reason `team-roles.ts` exists apart
 * from `auth-guards.ts`.
 *
 * The rationale for the SHAPE of the rule lives in `src/hr/lib/hr-roles.ts`;
 * keep it there rather than duplicating it here.
 */

/**
 * Roles that carry HR access on their own.
 *
 * SUPER_ADMIN because it is the platform owner and could grant itself the flag
 * anyway, so withholding it would be theatre. HR_USER because the role exists
 * for nothing else: confined to this module, a HR_USER without HR access could
 * reach nothing at all.
 *
 * ADMIN is deliberately absent (owner, Aug 31 2026): an admin needs the
 * per-person grant like anybody else.
 */
export const HR_SELF_SUFFICIENT_ROLES = new Set(["SUPER_ADMIN", "HR_USER"]);

/**
 * May this user see the HR module at all?
 *
 * Fails closed on an unknown role AND on an absent flag, so both ways of
 * arriving here without a decision having been made refuse: a role nobody has
 * classified, and a caller that forgot to select `hrAccess`.
 */
export function canViewHr(
  user: { role?: string | null; hrAccess?: boolean | null } | null | undefined,
): boolean {
  if (!user?.role) return false;
  if (HR_SELF_SUFFICIENT_ROLES.has(user.role)) return true;
  return user.hrAccess === true;
}

/**
 * May this user change HR data?
 *
 * Identical to read access, and that is a decision rather than an oversight:
 * the module has one operator plus whoever is granted, and a read-only HR role
 * has no described user. Kept separate so the day somebody wants an auditor who
 * can look and not touch, the call sites already ask the right question.
 */
export function canWriteHr(
  user: { role?: string | null; hrAccess?: boolean | null } | null | undefined,
): boolean {
  return canViewHr(user);
}

/**
 * The AuditLog `entityType` values the HR module writes. Anything in this set
 * is governed by `canViewHr`, wherever it is read from.
 *
 * WHY THIS EXISTS. The HR services write their audit rows into the shared
 * `AuditLog` table, stamped with the org like every other row. The org-wide
 * Activity feed is gated to ADMIN and SUPER_ADMIN, while HR is gated to
 * SUPER_ADMIN plus the per-person `hrAccess` grant, and the owner's ruling is
 * that ADMIN on its own is NOT enough to read a colleague's sick leave. So
 * without this set, an admin with no HR grant saw "Employee created, <name>"
 * in the feed, and the raw `/api/activity` JSON handed them every attendance
 * blob: employee id, leave code, date range. The exact exposure the grant
 * exists to prevent, one screen over.
 *
 * The default Changes query EXCLUDES this set; the HR tab's `?scope=hr` query
 * INCLUDES only it, behind `canViewHr`. The exclusion is the load-bearing
 * half; the tab is the convenience.
 *
 * KEPT IN SYNC BY A TEST, not by discipline: a source-level guard reads every
 * `entityType: "..."` literal under `src/hr/` and `src/app/api/hr/` and fails
 * if one is missing here. A new HR table whose audit rows silently landed back
 * in the general feed would be exactly the bug this set closes, recurring.
 */
export const HR_AUDIT_ENTITY_TYPES = [
  "Employee",
  "AttendanceEntry",
  "AttendanceRule",
  "LeaveGrant",
  "PublicHoliday",
  // The attendance CSV export (`recordExport` in the attendance route). An
  // export of who was off sick is HR activity as much as the entry that
  // recorded it, and the drift guard found this one on its first run.
  "HrAttendance",
] as const;

export type HrAuditEntityType = (typeof HR_AUDIT_ENTITY_TYPES)[number];

const HR_AUDIT_ENTITY_TYPE_SET: ReadonlySet<string> = new Set(HR_AUDIT_ENTITY_TYPES);

/** Is this AuditLog entityType one the HR boundary governs? */
export function isHrAuditEntityType(entityType: string): entityType is HrAuditEntityType {
  return HR_AUDIT_ENTITY_TYPE_SET.has(entityType);
}
