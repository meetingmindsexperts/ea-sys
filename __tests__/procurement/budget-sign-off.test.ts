/**
 * Sign-off and the approver overlap (owner, Sep 28 2026): the settle holder
 * may sign off a budget whose purchases they approved as the final
 * approver's stand-in; the overlap is recorded on the trail and shown on the
 * close-out, never blocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  eventBudget: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  spendRequest: { findMany: vi.fn() },
  budgetLine: { findMany: vi.fn().mockResolvedValue([]) },
  approvalStep: { findMany: vi.fn() },
  user: { findFirst: vi.fn().mockResolvedValue({ firstName: "Muthu", lastName: "Finance" }) },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/procurement/services/budget-category-service", () => ({ ensureBudgetCategories: vi.fn().mockResolvedValue([]) }));

import { signOffBudget } from "@/procurement/services/budget-service";

const ORG = "org-1";
const closed = { id: "b1", organizationId: ORG, eventId: "e1", status: "CLOSED", reportingCurrency: "AED", versionNo: 1, version: 4, signedOffByUserId: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.eventBudget.findFirst.mockResolvedValue(closed);
  mockDb.eventBudget.findMany.mockResolvedValue([{ id: "b1" }, { id: "b0" }]);
  mockDb.spendRequest.findMany.mockResolvedValue([{ id: "sr1", requestNo: "PR-2026-0001" }, { id: "sr2", requestNo: "PR-2026-0002" }]);
});

describe("signOffBudget", () => {
  it("a signer who approved some of the event's purchases signs off, and the trail names them", async () => {
    mockDb.approvalStep.findMany.mockResolvedValue([{ request: { subjectId: "sr2" } }]);
    await signOffBudget({ organizationId: ORG, actorUserId: "muthu", source: "ui", budgetId: "b1" });
    expect(mockDb.eventBudget.updateMany.mock.calls[0][0].data).toMatchObject({ signedOffByUserId: "muthu" });
    // Every version of the event counts, not only the one being signed off.
    expect(mockDb.spendRequest.findMany.mock.calls[0][0].where).toMatchObject({ budgetId: { in: ["b1", "b0"] } });
    expect(mockDb.auditLog.create.mock.calls.at(-1)?.[0].data).toMatchObject({ action: "SIGN_OFF", changes: { signerApprovedPurchases: ["PR-2026-0002"] } });
  });
  it("a signer who approved nothing leaves no overlap on the trail", async () => {
    mockDb.approvalStep.findMany.mockResolvedValue([]);
    await signOffBudget({ organizationId: ORG, actorUserId: "muthu", source: "ui", budgetId: "b1" });
    expect(mockDb.auditLog.create.mock.calls.at(-1)?.[0].data.changes.signerApprovedPurchases).toBeUndefined();
  });
});
