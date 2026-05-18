import { Prisma } from "@prisma/client";

/**
 * Returns the next registration serialId for an event, atomically.
 *
 * Backed by the `RegistrationSerialCounter` table: the upsert compiles to
 * `INSERT ... ON CONFLICT DO UPDATE SET lastSerial = lastSerial + 1`, which
 * takes a row lock so concurrent registrations serialize and can never
 * collide on `@@unique([eventId, serialId])`.
 *
 * The previous implementation used `aggregate(_max: serialId) + 1`. A MAX()
 * takes NO lock under Read Committed even inside a transaction, so two
 * simultaneous registrations both read the same max, both inserted the same
 * serialId, and one hit P2002 — which the public register route then
 * mis-reported as "You are already registered for this event".
 *
 * Still expects to be called inside the same `db.$transaction` as the
 * registration insert so a later failure rolls the counter back.
 */
export async function getNextSerialId(
  tx: Prisma.TransactionClient,
  eventId: string
): Promise<number> {
  const counter = await tx.registrationSerialCounter.upsert({
    where: { eventId },
    create: { eventId, lastSerial: 1 },
    update: { lastSerial: { increment: 1 } },
  });
  return counter.lastSerial;
}

/**
 * Formats a serialId as a zero-padded string, e.g. 1 → "001", 42 → "042".
 */
export function formatSerialId(serialId: number | null | undefined): string {
  if (serialId == null) return "—";
  return String(serialId).padStart(3, "0");
}
