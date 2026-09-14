/**
 * Document numbers for purchasing (owner decision, 14 Sep 2026):
 * `PR-2026-0001` for a spend request, `PO-2026-0001` for a purchase order.
 * The year is the Dubai calendar year of the moment the document is created
 * and the sequence restarts each January, so the counters key on
 * (organizationId, year). One organisation-wide sequence per type, never per
 * event (spec §5).
 *
 * `nextDocumentNumber` is the RegistrationSerialCounter mechanism: an upsert
 * that compiles to INSERT ... ON CONFLICT DO UPDATE SET lastSerial + 1, which
 * takes a row lock, so twenty concurrent creates get twenty distinct numbers.
 * It MUST run inside the creating transaction so a failed create rolls the
 * number back rather than leaving a gap.
 */
import type { Prisma } from "@prisma/client";

export type DocumentKind = "PR" | "PO";

const DUBAI_YEAR = new Intl.DateTimeFormat("en", { timeZone: "Asia/Dubai", year: "numeric" });

/** The calendar year in Asia/Dubai of `at`, the year that goes into the number. */
export function documentYear(at: Date = new Date()): number {
  return Number(DUBAI_YEAR.format(at));
}

export function formatDocumentNumber(kind: DocumentKind, year: number, serial: number): string {
  if (!Number.isInteger(serial) || serial < 1) throw new RangeError("A document serial starts at 1.");
  return `${kind}-${year}-${String(serial).padStart(4, "0")}`;
}

export async function nextDocumentNumber(tx: Prisma.TransactionClient, kind: DocumentKind, organizationId: string, at: Date = new Date()): Promise<string> {
  const year = documentYear(at);
  const where = { organizationId_year: { organizationId, year } };
  const create = { organizationId, year, lastSerial: 1 };
  const update = { lastSerial: { increment: 1 } };
  const counter = kind === "PR"
    ? await tx.spendRequestCounter.upsert({ where, create, update })
    : await tx.commitmentCounter.upsert({ where, create, update });
  return formatDocumentNumber(kind, year, counter.lastSerial);
}
