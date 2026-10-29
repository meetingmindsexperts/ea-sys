import type { Prisma } from "@prisma/client";

/**
 * Row locks for the paths that move seats on EXISTING registrations
 * (Oct 29, 2026). The lock order every such path follows: the registration
 * rows first (by id), then the seat counters (type before tier,
 * registration-seat-db.ts). Cancel already took its row first; the single
 * edit and the bulk moves took the counters first or read before their
 * transaction, so a cancel or an edit landing in between was released or
 * claimed twice.
 */

/** Lock these registrations for the rest of the transaction, in id order. */
export async function lockRegistrationRows(
  tx: Prisma.TransactionClient,
  eventId: string,
  registrationIds: readonly string[],
): Promise<void> {
  if (registrationIds.length === 0) return;
  await tx.$queryRaw`
    SELECT id FROM "Registration"
    WHERE id = ANY(${[...registrationIds]}::text[]) AND "eventId" = ${eventId}
    ORDER BY id FOR UPDATE`;
}

/**
 * Lock one registration and confirm it is still the row the caller read
 * before the transaction. "gone" when it was deleted, "changed" when any write
 * landed since (its updatedAt moved), else "unchanged".
 */
export async function lockRegistrationIfUnchanged(
  tx: Prisma.TransactionClient,
  registrationId: string,
  readUpdatedAt: Date,
): Promise<"unchanged" | "changed" | "gone"> {
  const rows = await tx.$queryRaw<Array<{ updatedAt: Date }>>`
    SELECT "updatedAt" FROM "Registration" WHERE id = ${registrationId} FOR UPDATE`;
  if (rows.length === 0) return "gone";
  return rows[0].updatedAt.getTime() === readUpdatedAt.getTime() ? "unchanged" : "changed";
}
