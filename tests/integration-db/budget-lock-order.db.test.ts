/**
 * One lock order for every budget write, on a REAL Postgres (review M1 of the
 * write-integrity change, Oct 28, 2026): a line save claims the budget row
 * and then the line; an order being issued on the same line must take the
 * budget row before the line too, or the two deadlock (Postgres 40P01). The
 * first cut used FOR UPDATE for that, which deadlocked two orders against
 * each other through the order insert's foreign-key lock (committed-figures
 * test); NO KEY UPDATE is the lock that serves both.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { closeBudget, reopenBudget, upsertBudgetLine, recomputeBudgetTotals } from "@/procurement/services/budget-service";
import { syncLineCommitted } from "@/procurement/services/committed-figures";
import { resetCrm } from "./helper";

let orgId: string;
let userId: string;
let budgetId: string;
let lineId: string;
let supplierId: string;
let n = 0;

beforeAll(async () => {
  ({ orgId, userId } = await resetCrm());
  const event = await db.event.create({ data: { organizationId: orgId, name: "Lock order", code: "LOCK26", slug: `lock-${Date.now()}`, startDate: new Date("2026-12-01"), endDate: new Date("2026-12-02") }, select: { id: true } });
  const category = await db.budgetCategory.create({ data: { organizationId: orgId, code: "AV", name: "Audio visual" }, select: { id: true } });
  supplierId = (await db.supplier.create({ data: { organizationId: orgId, code: "GAV", legalName: "Gulf AV LLC", displayName: "Gulf AV", currency: "AED" }, select: { id: true } })).id;
  budgetId = (await db.eventBudget.create({ data: { organizationId: orgId, eventId: event.id, eventCode: "LOCK26", versionNo: 1, reportingCurrency: "AED", ownerUserId: userId, createdByUserId: userId, status: "ACTIVE" }, select: { id: true } })).id;
  lineId = (await db.budgetLine.create({ data: { organizationId: orgId, budgetId, lineKey: "k-av", categoryId: category.id, description: "LED wall", transactionCurrency: "AED", qty: "1", unitCost: "100000", planned: "100000" }, select: { id: true } })).id;
}, 120_000);

/** What issuing an order does to the budget: insert it, sync the line's committed figures, recompute totals. */
function issue() {
  // Captured now: the transaction body runs later, after the next call has moved the counter on.
  const no = `PO-L-${(n += 1)}`;
  return db.$transaction(async (tx) => {
    await tx.commitment.create({ data: { organizationId: orgId, commitmentNo: no, budgetId, lineKey: "k-av", supplierId, eventCode: "LOCK26", currency: "AED", amount: "100", fxRateToReporting: "1", status: "APPROVED" } });
    const target = await syncLineCommitted(tx as never, { organizationId: orgId, budgetId, lineKey: "k-av" });
    if (target) await recomputeBudgetTotals(tx as never, target);
  }, { timeout: 20_000, maxWait: 20_000 });
}

describe("a line save and an order on the same line never deadlock", () => {
  it("runs 25 rounds of a forecast save racing two orders, with no deadlock and every order counted", async () => {
    const errors: string[] = [];
    for (let i = 0; i < 25; i++) {
      const results = await Promise.allSettled([
        runWithTenant(orgId, () => upsertBudgetLine({ organizationId: orgId, actorUserId: userId, source: "ui", budgetId, lineId, notes: `round ${i}` })),
        issue(),
        issue(),
      ]);
      for (const [k, r] of results.entries()) if (r.status === "rejected") errors.push(`#${k} ${(r.reason as { code?: string }).code} ${JSON.stringify((r.reason as { meta?: unknown }).meta)}`.slice(0, 200));
      const save = results[0];
      // The save either lands or loses its claim to an order's totals write; it never fails for any other reason.
      if (save.status === "fulfilled" && !save.value.ok) expect(save.value.code).toBe("STALE_WRITE");
    }
    expect(errors, "no transaction failed (a 40P01 deadlock would show here)").toEqual([]);
    const line = await db.budgetLine.findUniqueOrThrow({ where: { id: lineId }, select: { committedOpen: true } });
    expect(line.committedOpen.toFixed(4)).toBe((50 * 100).toFixed(4));
  });

  it("runs 20 rounds of a close (with variance notes) racing a line save, with no deadlock", async () => {
    // The close wrote its notes before the budget row: line then budget, the reverse of the claim (review MED).
    const lineKey = (await db.budgetLine.findUniqueOrThrow({ where: { id: lineId }, select: { lineKey: true } })).lineKey;
    const failures: string[] = [];
    for (let i = 0; i < 20; i++) {
      const [closed, saved] = await Promise.all([
        runWithTenant(orgId, () => closeBudget({ organizationId: orgId, actorUserId: userId, source: "ui", budgetId, varianceNotes: { [lineKey]: `round ${i}` } })),
        new Promise((r) => setTimeout(r, Math.random() * 40)).then(() => runWithTenant(orgId, () => upsertBudgetLine({ organizationId: orgId, actorUserId: userId, source: "ui", budgetId, lineId, notes: `save ${i}` }))),
      ]);
      // Either may lose the race politely (STALE_WRITE, or the save meeting a closed budget); neither may fail.
      for (const r of [closed, saved]) if (!r.ok && !["STALE_WRITE", "INVALID_STATUS", "VARIANCE_NOTES_REQUIRED"].includes(r.code)) failures.push(`round ${i}: ${r.code}`);
      const status = (await db.eventBudget.findUniqueOrThrow({ where: { id: budgetId }, select: { status: true } })).status;
      if (status === "CLOSED") {
        const reopened = await runWithTenant(orgId, () => reopenBudget({ organizationId: orgId, actorUserId: userId, source: "ui", budgetId, reason: "next round" }));
        if (!reopened.ok) failures.push(`round ${i}: reopen ${reopened.code}`);
      }
    }
    expect(failures, "no UNKNOWN (a 40P01 deadlock surfaces as UNKNOWN)").toEqual([]);
  });
});
