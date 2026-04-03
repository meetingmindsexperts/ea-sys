import { Prisma, InvoiceType } from "@prisma/client";

const TYPE_CODES: Record<InvoiceType, string> = {
  INVOICE: "INV",
  RECEIPT: "REC",
  CREDIT_NOTE: "CN",
};

/**
 * Atomically generates the next invoice number for an event.
 * Must be called inside a db.$transaction to prevent race conditions.
 *
 * Format: {eventCode}-{typeCode}-{001}
 * Examples: HFC2026-INV-001, HFC2026-REC-005, HFC2026-CN-002
 *
 * For quotes (not stored as Invoice records): {eventCode}-Q-{001}
 */
export async function getNextInvoiceNumber(
  tx: Prisma.TransactionClient,
  eventId: string,
  type: InvoiceType,
  eventCode: string
): Promise<{ sequenceNumber: number; invoiceNumber: string }> {
  const counter = await tx.invoiceCounter.upsert({
    where: {
      eventId_type: { eventId, type },
    },
    create: { eventId, type, lastSequence: 1 },
    update: { lastSequence: { increment: 1 } },
  });

  const seq = counter.lastSequence;
  const typeCode = TYPE_CODES[type];
  const invoiceNumber = `${eventCode}-${typeCode}-${String(seq).padStart(3, "0")}`;

  return { sequenceNumber: seq, invoiceNumber };
}

/**
 * Generates a quote number for a registration (not stored in Invoice table).
 * Format: {eventCode}-Q-{serialId}
 */
export function formatQuoteNumber(eventCode: string, serialId: number | null): string {
  if (!serialId) return "";
  return `${eventCode}-Q-${String(serialId).padStart(3, "0")}`;
}
