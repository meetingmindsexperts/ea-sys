import { Prisma, InvoiceType } from "@prisma/client";

/**
 * Atomically generates the next invoice number for an organization.
 * Must be called inside a db.$transaction to prevent race conditions.
 *
 * Format: {prefix}-{year}-{0001}
 * Examples: INV-2026-0001, REC-2026-0042, CN-2026-0003
 */
export async function getNextInvoiceNumber(
  tx: Prisma.TransactionClient,
  organizationId: string,
  type: InvoiceType,
  prefix?: string
): Promise<{ sequenceNumber: number; invoiceNumber: string }> {
  const year = new Date().getFullYear();

  // Upsert + increment atomically
  const counter = await tx.invoiceCounter.upsert({
    where: {
      organizationId_type_year: { organizationId, type, year },
    },
    create: { organizationId, type, year, lastSequence: 1 },
    update: { lastSequence: { increment: 1 } },
  });

  const seq = counter.lastSequence;
  const typePrefix =
    type === "INVOICE"
      ? (prefix || "INV")
      : type === "RECEIPT"
        ? "REC"
        : "CN";

  const invoiceNumber = `${typePrefix}-${year}-${String(seq).padStart(4, "0")}`;

  return { sequenceNumber: seq, invoiceNumber };
}
