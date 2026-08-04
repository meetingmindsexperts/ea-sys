import { Prisma } from "@prisma/client";

/**
 * Returns the next session-proposal serialId for an event, atomically.
 *
 * Third sibling of registration-serial.ts / abstract-serial.ts — same atomic
 * `INSERT ... ON CONFLICT DO UPDATE SET lastSerial = lastSerial + 1` upsert so
 * concurrent submissions serialize and never collide on
 * `@@unique([eventId, serialId])`.
 *
 * Must be called inside the same `db.$transaction` as the proposal insert so
 * a later failure rolls the counter back.
 */
export async function getNextSessionProposalSerialId(
  tx: Prisma.TransactionClient,
  eventId: string,
  organizationId: string
): Promise<number> {
  const counter = await tx.sessionProposalSerialCounter.upsert({
    where: { eventId },
    create: { eventId, lastSerial: 1, organizationId },
    update: { lastSerial: { increment: 1 }, organizationId },
  });
  return counter.lastSerial;
}

/**
 * Formats a session-proposal serialId for display, e.g. 1 → "S-001".
 * "S-" keeps it distinct from Registration # ("001") and Abstract # ("A-001").
 *
 * Pure + client-safe — imported by client components.
 */
export function formatSessionProposalSerial(serialId: number | null | undefined): string {
  if (serialId == null) return "—";
  return `S-${String(serialId).padStart(3, "0")}`;
}
