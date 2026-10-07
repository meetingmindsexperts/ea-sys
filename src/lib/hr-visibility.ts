/**
 * The HR module's audit entity types, with no server-only imports.
 *
 * WHO may see HR is `hr.read` / `hr.write`, asked through `can()` (custom
 * roles Phase 6, Oct 6, 2026). The per-person `hrAccess` tick is a person
 * grant; SUPER_ADMIN and HR_USER carry it by their role (their system roles'
 * `impliedPersonGrants`), ADMIN does not (owner, Aug 31, 2026). `canViewHr`,
 * `canWriteHr` and `HR_SELF_SUFFICIENT_ROLES` lived here and are gone; the
 * answer per role is frozen in `system-role-grants-snapshot.test.ts`.
 */

/**
 * The AuditLog `entityType` values the HR module writes. Anything in this set
 * is governed by `hr.read`, wherever it is read from.
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
 * INCLUDES only it, behind `hr.read`. The exclusion is the load-bearing
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
