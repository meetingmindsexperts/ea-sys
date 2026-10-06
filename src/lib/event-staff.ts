import { db } from "@/lib/db";

export { assignedToEventWhere } from "@/lib/event-staff-where";

/**
 * Assigned event staff (custom roles Phase 4, Oct 5, 2026): who holds an
 * ASSIGNED-scope grant on which event (today the ONSITE desk).
 *
 * The `EventStaffAssignment` table is the only store (release 2, Oct 6, 2026).
 * It replaced `Event.settings.onsiteUserIds` (JSON, no foreign key): release 1
 * wrote and read both for a deploy cycle, then production held no assignment
 * in the JSON that the table lacked, so the JSON is no longer written or read.
 * A leftover key in an old event's settings grants nothing. Every write goes
 * through this module.
 */

export async function assignEventStaff(input: {
  eventId: string;
  organizationId: string;
  userId: string;
  assignedById: string | null;
}): Promise<void> {
  const { eventId, organizationId, userId, assignedById } = input;
  await db.eventStaffAssignment.upsert({
    where: { eventId_userId: { eventId, userId } },
    create: { eventId, organizationId, userId, assignedById },
    update: {},
  });
}

export async function unassignEventStaff(input: { eventId: string; userId: string }): Promise<void> {
  const { eventId, userId } = input;
  await db.eventStaffAssignment.deleteMany({ where: { eventId, userId } });
}

/** Everyone assigned to the event. */
export async function eventStaffUserIds(eventId: string): Promise<string[]> {
  const rows = await db.eventStaffAssignment.findMany({ where: { eventId }, select: { userId: true } });
  return rows.map((r) => r.userId);
}
