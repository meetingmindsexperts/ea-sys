/**
 * The row claim every budget line write takes first (budget-service and
 * budget-revenue-service both use it; its own module so neither imports the
 * other for it).
 */
import type { Db } from "@/lib/approvals/approvals-service";

/** Thrown inside a transaction when the budget changed after it was read; the caller maps it to STALE_WRITE. */
export class BudgetStaleWrite extends Error {
  constructor() {
    super("STALE");
  }
}

/**
 * Claims the budget row for a line write, FIRST inside the transaction
 * (adversarial tests P0-2 and P0-3, Oct 28, 2026): a conditional update on the
 * version this request read, and on DRAFT when the plan changes. Two writers
 * that read the same version cannot both match: Postgres takes the row lock
 * here, the second waits, re-reads, matches nothing and throws, so its whole
 * transaction rolls back. A submit that lands between this request's read and
 * its write bumps the version and moves the status, so a line edit can no
 * longer slip onto a budget under review, and the approval amount is always
 * the plan that was submitted.
 */
export async function claimBudgetForWrite(tx: Db, b: { id: string; version: number }, opts: { requireDraft: boolean }): Promise<void> {
  const res = await tx.eventBudget.updateMany({
    where: { id: b.id, version: b.version, status: opts.requireDraft ? "DRAFT" : { notIn: ["CLOSED", "ARCHIVED"] } },
    data: { version: { increment: 1 } },
  });
  if (res.count === 0) throw new BudgetStaleWrite();
}
