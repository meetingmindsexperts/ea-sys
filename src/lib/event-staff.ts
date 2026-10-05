import { db } from "@/lib/db";
import { updateEventSettings } from "@/lib/event-settings";

export { assignedToEventWhere } from "@/lib/event-staff-where";

/**
 * Assigned event staff (custom roles Phase 4, Oct 5, 2026): who holds an
 * ASSIGNED-scope grant on which event (today the ONSITE desk).
 *
 * The truth moves from `Event.settings.onsiteUserIds` (JSON, no foreign key)
 * to the `EventStaffAssignment` table. For one release BOTH are written here
 * and the access checks accept either (`assignedToEventWhere` in
 * `event-staff-where.ts`), so neither a
 * deploy nor a rollback strands an assignment. The next release stops writing
 * and reading the JSON. Every write goes through this module: there is no
 * second place that knows the two stores exist.
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
  await updateEventSettings(eventId, (cur) => ({
    ...cur,
    onsiteUserIds: Array.from(new Set([...((cur.onsiteUserIds as string[]) ?? []), userId])),
  }));
}

export async function unassignEventStaff(input: { eventId: string; userId: string }): Promise<void> {
  const { eventId, userId } = input;
  await db.eventStaffAssignment.deleteMany({ where: { eventId, userId } });
  await updateEventSettings(eventId, (cur) => ({
    ...cur,
    onsiteUserIds: ((cur.onsiteUserIds as string[]) ?? []).filter((id) => id !== userId),
  }));
}

/** Everyone assigned to the event, from both stores. */
export async function eventStaffUserIds(eventId: string, settings: unknown): Promise<string[]> {
  const rows = await db.eventStaffAssignment.findMany({ where: { eventId }, select: { userId: true } });
  const json = (settings && typeof settings === "object" ? (settings as { onsiteUserIds?: unknown }).onsiteUserIds : null) ?? [];
  const fromJson = Array.isArray(json) ? json.filter((v): v is string => typeof v === "string") : [];
  return Array.from(new Set([...rows.map((r) => r.userId), ...fromJson]));
}
