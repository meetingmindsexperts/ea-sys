import { Prisma } from "@prisma/client";

/**
 * Returns the next abstract serialId for an event, atomically.
 *
 * Mirrors src/lib/registration-serial.ts exactly: the upsert compiles to
 * `INSERT ... ON CONFLICT DO UPDATE SET lastSerial = lastSerial + 1`, which
 * takes a row lock so concurrent submissions serialize and can never collide
 * on `@@unique([eventId, serialId])` (a MAX()+1 read would race — see the
 * registration counter's history for the P2002 bug that pattern caused).
 *
 * Must be called inside the same `db.$transaction` as the abstract insert so
 * a later failure rolls the counter back.
 *
 * `organizationId` is the caller's already-verified org for the event —
 * stamped on the create branch (multi-tenancy denormalized tenant key) and
 * re-stamped on the update branch as a self-heal.
 */
export async function getNextAbstractSerialId(
  tx: Prisma.TransactionClient,
  eventId: string,
  organizationId: string
): Promise<number> {
  const counter = await tx.abstractSerialCounter.upsert({
    where: { eventId },
    create: { eventId, lastSerial: 1, organizationId },
    update: { lastSerial: { increment: 1 }, organizationId },
  });
  return counter.lastSerial;
}

/**
 * Formats an abstract serialId for display, e.g. 1 → "A-001", 42 → "A-042".
 * The "A-" prefix keeps it visually distinct from the Registration # ("001")
 * when the two appear side by side (organizer decision, Aug 4 2026).
 *
 * Pure + client-safe — imported by client components.
 */
export function formatAbstractSerial(serialId: number | null | undefined): string {
  if (serialId == null) return "—";
  return `A-${String(serialId).padStart(3, "0")}`;
}
