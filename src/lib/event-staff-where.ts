import type { Prisma } from "@prisma/client";

/**
 * The event filter for "this person is assigned to work the event" (custom
 * roles Phase 4). Pure, no database import: `event-access.ts` and the
 * client-safe `can.ts` both build their ASSIGNED-scope lookups from it.
 *
 * Reads either store during the transition: the `EventStaffAssignment` row or
 * the `settings.onsiteUserIds` JSON it replaces (`src/lib/event-staff.ts`
 * writes both). The next release drops the JSON arm.
 */
export function assignedToEventWhere(userId: string): Prisma.EventWhereInput {
  return {
    OR: [{ staffAssignments: { some: { userId } } }, { settings: { path: ["onsiteUserIds"], array_contains: userId } }],
  };
}
