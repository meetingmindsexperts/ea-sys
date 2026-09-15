/**
 * A line's committed figures are summed from the event's orders under one
 * advisory lock and written to the event's current version (review of
 * 15 September 2026: the old read-add-write lost updates, and a new version
 * kept figures copied at draft time). The race itself is in
 * tests/crm-db/committed-figures.db.test.ts; this pins the shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  eventBudget: { findFirst: vi.fn(), findMany: vi.fn() },
  budgetLine: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  commitment: { findMany: vi.fn() },
}));
const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({ apiLogger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { eventBudgetIds, syncBudgetCommitted, syncLineCommitted } from "@/procurement/services/committed-figures";

const ORG = "org-1";
const order = (amount: string, fxRateToReporting: string, status = "APPROVED", lineKey = "k") => ({ lineKey, amount, fxRateToReporting, status });
const lockKey = () => tx.$queryRaw.mock.calls[0][1];

beforeEach(() => {
  vi.clearAllMocks();
  tx.$queryRaw.mockResolvedValue([]);
  tx.eventBudget.findFirst.mockResolvedValue({ id: "v1", eventId: "e1" });
  tx.eventBudget.findMany.mockResolvedValue([{ id: "v1", status: "ARCHIVED" }, { id: "v2", status: "ACTIVE" }]);
  tx.budgetLine.findFirst.mockResolvedValue({ id: "l2" });
  tx.budgetLine.update.mockResolvedValue({});
  tx.commitment.findMany.mockResolvedValue([]);
});

describe("syncLineCommitted", () => {
  it("locks the event, sums every version's orders on the key, and writes to the current version", async () => {
    tx.commitment.findMany.mockResolvedValue([order("1000.0000", "4.2"), order("300.0000", "1", "CLOSED")]);
    const target = await syncLineCommitted(tx as never, { organizationId: ORG, budgetId: "v1", lineKey: "k" });
    expect(target).toBe("v2");
    expect(lockKey()).toBe("procurement-committed:e1");
    expect(tx.eventBudget.findMany.mock.calls[0][0].where).toEqual({ organizationId: ORG, eventId: "e1" });
    expect(tx.budgetLine.findFirst.mock.calls[0][0].where).toEqual({ budgetId: "v2", lineKey: "k", deletedAt: null });
    expect(tx.commitment.findMany.mock.calls[0][0].where).toEqual({ organizationId: ORG, budgetId: { in: ["v1", "v2"] }, status: { not: "CANCELLED" }, lineKey: { in: ["k"] } });
    // A closed order still counts in the total, not in what is open.
    expect(tx.budgetLine.update).toHaveBeenCalledWith({ where: { id: "l2" }, data: { committedOpen: "4200.0000", committedTotal: "4500.0000" } });
  });
  it("with no active or frozen version, writes to the order's own version", async () => {
    tx.eventBudget.findMany.mockResolvedValue([{ id: "v1", status: "CLOSED" }]);
    expect(await syncLineCommitted(tx as never, { organizationId: ORG, budgetId: "v1", lineKey: "k" })).toBe("v1");
    expect(tx.budgetLine.findFirst.mock.calls[0][0].where.budgetId).toBe("v1");
  });
  it("an entity-level budget locks on its own id and reads only itself", async () => {
    tx.eventBudget.findFirst.mockResolvedValue({ id: "b9", eventId: null });
    tx.eventBudget.findMany.mockResolvedValue([{ id: "b9", status: "ACTIVE" }]);
    await syncLineCommitted(tx as never, { organizationId: ORG, budgetId: "b9", lineKey: "k" });
    expect(lockKey()).toBe("procurement-committed:b9");
    expect(tx.eventBudget.findMany.mock.calls[0][0].where).toEqual({ id: "b9", organizationId: ORG });
  });
  it("zeroes the line when no order is left on it", async () => {
    await syncLineCommitted(tx as never, { organizationId: ORG, budgetId: "v1", lineKey: "k" });
    expect(tx.budgetLine.update).toHaveBeenCalledWith({ where: { id: "l2" }, data: { committedOpen: "0.0000", committedTotal: "0.0000" } });
  });
  it("logs and writes nothing when the key is not on the current version, or the budget is gone", async () => {
    tx.budgetLine.findFirst.mockResolvedValueOnce(null);
    expect(await syncLineCommitted(tx as never, { organizationId: ORG, budgetId: "v1", lineKey: "k" })).toBe("v2");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "procurement/commitments:committed-line-missing", budgetId: "v2", lineKey: "k" }));
    tx.eventBudget.findFirst.mockResolvedValueOnce(null);
    expect(await syncLineCommitted(tx as never, { organizationId: ORG, budgetId: "gone", lineKey: "k" })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "procurement/commitments:committed-budget-missing" }));
    expect(tx.budgetLine.update).not.toHaveBeenCalled();
  });
});

describe("syncBudgetCommitted", () => {
  it("rewrites every line on the version from the event's orders, skipping lines already right", async () => {
    tx.budgetLine.findMany.mockResolvedValue([
      { id: "a", lineKey: "k1", committedOpen: "4200.0000", committedTotal: "4200.0000" },
      { id: "b", lineKey: "k2", committedOpen: "100.0000", committedTotal: "100.0000" },
    ]);
    tx.commitment.findMany.mockResolvedValue([order("1000.0000", "4.2", "APPROVED", "k1")]);
    await syncBudgetCommitted(tx as never, ORG, "v2");
    expect(tx.commitment.findMany.mock.calls[0][0].where).toEqual({ organizationId: ORG, budgetId: { in: ["v1", "v2"] }, status: { not: "CANCELLED" } });
    expect(tx.budgetLine.update).toHaveBeenCalledTimes(1);
    expect(tx.budgetLine.update).toHaveBeenCalledWith({ where: { id: "b" }, data: { committedOpen: "0.0000", committedTotal: "0.0000" } });
  });
});

describe("eventBudgetIds", () => {
  it("reads every version of the event without taking the lock, or only the budget itself when it has no event", async () => {
    tx.eventBudget.findMany.mockResolvedValue([{ id: "v1" }, { id: "v2" }]);
    expect(await eventBudgetIds(tx as never, ORG, "v1")).toEqual(["v1", "v2"]);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    tx.eventBudget.findFirst.mockResolvedValueOnce({ id: "b9", eventId: null });
    expect(await eventBudgetIds(tx as never, ORG, "b9")).toEqual(["b9"]);
  });
});
