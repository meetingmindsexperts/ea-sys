/**
 * The adversarial test plan of Oct 28, 2026, pinned at the service:
 *  P0-1 an audit insert that fails inside a financial mutation fails the
 *       mutation, never reports success for a rolled-back write;
 *  P0-2 / P0-3 every line write and the submit are conditional on the
 *       version read, so a lost race is STALE_WRITE and writes nothing;
 *  P1-2 an unsupported line currency is refused before any write.
 * The races themselves are exercised on a real database by
 * scripts/budget-race-check.ts; these pin the shape that makes them safe.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, tx } = vi.hoisted(() => {
  const tx = {
    eventBudget: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    budgetLine: { create: vi.fn(), update: vi.fn(), aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: 0 } }), findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const mockDb = {
    eventBudget: { findFirst: vi.fn() },
    budgetLine: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    budgetCategory: { findFirst: vi.fn().mockResolvedValue({ id: "c-av", code: "510300" }), findMany: vi.fn().mockResolvedValue([]) },
    budgetProduct: { findFirst: vi.fn() },
    $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  return { mockDb, tx };
});
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (cb: (t: unknown) => unknown) => (mockDb.$transaction as (cb: (t: unknown) => unknown) => unknown)(cb) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/approvals/approvals-service", () => ({
  createApprovalRequest: vi.fn().mockResolvedValue({ ok: true, request: { id: "req-1" } }),
  cancelPendingApprovals: vi.fn(), decideApprovalRequest: vi.fn(), subjectsApprovedBy: vi.fn(),
}));
vi.mock("@/procurement/services/budget-category-service", () => ({ ensureBudgetCategories: vi.fn().mockResolvedValue([]) }));

import { deleteBudgetLine, submitBudget, upsertBudgetLine } from "@/procurement/services/budget-service";
import { upsertBudgetLineSchema } from "@/procurement/lib/budget-schemas";

/** The source of a `.catch(` argument, from just after the parenthesis to its matching close. */
function catchHandler(src: string, from: number): string {
  let depth = 1;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "(") depth++;
    if (src[i] === ")") depth--;
    if (depth === 0) return src.slice(from, i);
  }
  return src.slice(from);
}

const ORG = "org-1";
const draft = { id: "b1", organizationId: ORG, status: "DRAFT", reportingCurrency: "AED", versionNo: 1, version: 7, naCategoryCodes: [], contingencyPercent: "10", contingencyAmount: "0.0000", plannedExpenseTotal: "1000.0000", taxTotalPlanned: "0.0000", forecastTotal: "0.0000", expectedAttendance: 100 };
const base = { organizationId: ORG, actorUserId: "u1", source: "ui" as const, budgetId: "b1" };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.eventBudget.findFirst.mockResolvedValue(draft);
  tx.eventBudget.updateMany.mockResolvedValue({ count: 1 });
  tx.auditLog.create.mockResolvedValue({});
});

describe("P0-1: a failed audit fails the mutation", () => {
  it("returns UNKNOWN, never ok, when the audit insert fails inside the transaction", async () => {
    tx.auditLog.create.mockRejectedValue(Object.assign(new Error("fk"), { code: "P2003" }));
    const r = await upsertBudgetLine({ ...base, categoryId: "c-av", description: "AV", qty: 1, unitCost: 100 });
    expect(r).toMatchObject({ ok: false, code: "UNKNOWN" });
  });

  it("no in-transaction audit helper in the money services swallows its error", () => {
    // A .catch that logs and does not rethrow is the bug: Postgres has aborted the transaction,
    // so the write rolls back while the caller is told it succeeded (measured on the local DB).
    const files = [
      "src/procurement/services/budget-service.ts",
      "src/procurement/services/budget-revenue-service.ts",
      "src/procurement/services/spend-request-service.ts",
      "src/procurement/services/commitment-service.ts",
      "src/lib/approvals/approvals-service.ts",
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const swallowed = src.match(/audit-failed"[^;]*?\}\)\);/g) ?? [];
      expect(swallowed, `${f} swallows an audit failure`).toEqual([]);
      // Every .catch hung on an auditLog write must rethrow, whatever its log message or shape
      // (".catch(() => {})" included): the handler is read up to the end of its statement.
      for (const m of src.matchAll(/auditLog[\s\S]{0,600}?\.catch\(/g)) {
        const handler = catchHandler(src, m.index! + m[0].length);
        expect(handler.includes("throw"), `${f}: an auditLog .catch near offset ${m.index} does not rethrow`).toBe(true);
      }
    }
  });
});

describe("P0-2 / P0-3: writes are conditional on the version read", () => {
  it("claims the budget row first, on the version read and DRAFT, and answers STALE_WRITE when it loses", async () => {
    tx.eventBudget.updateMany.mockResolvedValue({ count: 0 });
    const r = await upsertBudgetLine({ ...base, categoryId: "c-av", description: "AV", qty: 1, unitCost: 100 });
    expect(r).toMatchObject({ ok: false, code: "STALE_WRITE" });
    expect(tx.eventBudget.updateMany).toHaveBeenCalledWith({ where: { id: "b1", version: 7, status: "DRAFT" }, data: { version: { increment: 1 } } });
    expect(tx.budgetLine.create).not.toHaveBeenCalled();
  });

  it("a notes-only edit on an open budget claims without demanding DRAFT", async () => {
    mockDb.eventBudget.findFirst.mockResolvedValue({ ...draft, status: "ACTIVE" });
    mockDb.budgetLine.findFirst.mockResolvedValue({ id: "l1", lineKey: "k1", productId: null, product: null, categoryId: "c-av", description: "AV", qty: "1", unitCost: "100", transactionCurrency: "AED", fxRateToReporting: "1", taxRatePercent: null, taxCode: null, serviceStart: null, serviceEnd: null, sortOrder: 0, isContingency: false, deletedAt: null, forecastReason: null });
    await upsertBudgetLine({ ...base, lineId: "l1", notes: "check the quote" });
    expect(tx.eventBudget.updateMany).toHaveBeenCalledWith({ where: { id: "b1", version: 7, status: { notIn: ["CLOSED", "ARCHIVED"] } }, data: { version: { increment: 1 } } });
  });

  it("a line removal that loses the claim is STALE_WRITE and removes nothing", async () => {
    mockDb.budgetLine.findFirst.mockResolvedValue({ id: "l1", isContingency: false, committedOpen: "0", description: "AV" });
    tx.eventBudget.updateMany.mockResolvedValue({ count: 0 });
    expect(await deleteBudgetLine({ ...base, lineId: "l1" })).toMatchObject({ ok: false, code: "STALE_WRITE" });
    expect(tx.budgetLine.update).not.toHaveBeenCalled();
  });

  it("the submit moves the status only on the version whose total priced the approval", async () => {
    // One planned line, so the completeness check passes and the submit reaches its transaction.
    mockDb.budgetLine.findMany.mockResolvedValue([{ id: "l1", lineKey: "k1", categoryId: "c-av", category: { id: "c-av", code: "510300", name: "Technical", parentId: null, isActive: true }, description: "AV", qty: "1", unitCost: "1000", transactionCurrency: "AED", fxRateToReporting: "1", planned: "1000.0000", committedOpen: "0", committedTotal: "0", actual: "0", paid: "0", taxAmountPlanned: "0", isContingency: false, deletedAt: null, sortOrder: 0 }]);
    tx.eventBudget.updateMany.mockResolvedValue({ count: 0 });
    const r = await submitBudget({ ...base });
    expect(tx.eventBudget.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "b1", status: "DRAFT", version: 7 }) }));
    expect(r).toMatchObject({ ok: false, code: "STALE_WRITE" });
  });
});

describe("P1-2: unsupported currencies are refused before any write", () => {
  it("accepts the module's currencies in any case and refuses anything else", () => {
    expect(upsertBudgetLineSchema.safeParse({ transactionCurrency: "usd" }).success).toBe(true);
    expect(upsertBudgetLineSchema.safeParse({ transactionCurrency: "XYZ" }).success).toBe(false);
    expect(upsertBudgetLineSchema.safeParse({ transactionCurrency: "OMR" }).success).toBe(false);
  });
});
