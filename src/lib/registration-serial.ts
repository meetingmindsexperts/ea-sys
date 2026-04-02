import { Prisma } from "@prisma/client";

/**
 * Returns the next available serialId for a registration within an event.
 * Must be called inside a db.$transaction to avoid race conditions.
 */
export async function getNextSerialId(
  tx: Prisma.TransactionClient,
  eventId: string
): Promise<number> {
  const result = await tx.registration.aggregate({
    where: { eventId },
    _max: { serialId: true },
  });
  return (result._max.serialId ?? 0) + 1;
}

/**
 * Formats a serialId as a zero-padded string, e.g. 1 → "001", 42 → "042".
 */
export function formatSerialId(serialId: number | null | undefined): string {
  if (serialId == null) return "—";
  return String(serialId).padStart(3, "0");
}
