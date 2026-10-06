import type { Prisma } from "@prisma/client";

/**
 * The event filter for "this person is assigned to work the event" (custom
 * roles Phase 4). Pure, no database import: `event-access.ts` and the
 * client-safe `can.ts` both build their ASSIGNED-scope lookups from it.
 *
 * Reads the `EventStaffAssignment` rows only. The `settings.onsiteUserIds`
 * JSON it replaced is not consulted (Phase 4 release 2, Oct 6, 2026), so a
 * leftover id there grants nothing.
 */
export function assignedToEventWhere(userId: string): Prisma.EventWhereInput {
  return { staffAssignments: { some: { userId } } };
}
