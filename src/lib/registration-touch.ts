import type { Prisma } from "@prisma/client";

/**
 * Move Registration.updatedAt for the registrations on these attendees, after
 * a write to the Attendee row only (Oct 29, 2026). A staff edit carries the
 * registration's updatedAt as its "changed since you opened it" token and
 * sends the attendee's fields (tags included) back on every save, so an
 * attendee-only write that left updatedAt alone was silently reverted by the
 * next save from an older screen. person-details-sync does the same.
 */
export async function touchRegistrationsOfAttendees(
  client: { registration: Pick<Prisma.TransactionClient["registration"], "updateMany"> },
  attendeeIds: readonly string[],
): Promise<void> {
  if (attendeeIds.length === 0) return;
  await client.registration.updateMany({
    where: { attendeeId: { in: [...new Set(attendeeIds)] } },
    data: { updatedAt: new Date() },
  });
}
