/**
 * Sign-off and the per-purchase separation (Sep 28, 2026): whoever approved
 * any of the event's purchases (the settle holder standing in for the final
 * approver) does not sign off that budget; the super admin, who never
 * approves, signs it off instead.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  eventBudget: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  spendRequest: { findMany: vi.fn() },
  budgetLine: { findMany: vi.fn().mockResolvedValue([]) },
  approvalStep: { findMany: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/procurement/services/budget-category-service", () => ({ ensureBudgetCategories: vi.fn().mockResolvedValue([]) }));

import { signOffBudget } from "@/procurement/services/budget-service";

const ORG = "org-1";
const closed = { id: "b1", organizationId: ORG, eventId: "e1", status: "CLOSED", reportingCurrency: "AED", versionNo: 1, version: 4 };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.eventBudget.findFirst.mockResolvedValue(closed);
  mockDb.eventBudget.findMany.mockResolvedValue([{ id: "b1" }, { id: "b0" }]);
  mockDb.spendRequest.findMany.mockResolvedValue([{ id: "sr1", requestNo: "PR-2026-0001" }, { id: "sr2", requestNo: "PR-2026-0002" }]);
});

describe("signOffBudget", () => {
  it("refuses a signer who approved one of the event's purchases, naming it, and writes nothing", async () => {
    mockDb.approvalStep.findMany.mockResolvedValue([{ request: { subjectId: "sr2" } }]);
    const r = await signOffBudget({ organizationId: ORG, actorUserId: "muthu", actorRole: "ADMIN", source: "ui", budgetId: "b1" });
    expect(r).toMatchObject({ ok: false, code: "SIGNER_APPROVED_PURCHASES", meta: { requestNos: ["PR-2026-0002"] } });
    // Every version of the event counts, not only the one being signed off.
    expect(mockDb.spendRequest.findMany.mock.calls[0][0].where).toMatchObject({ budgetId: { in: ["b1", "b0"] } });
    expect(mockDb.eventBudget.updateMany).not.toHaveBeenCalled();
  });
  it("lets a signer who approved nothing sign off", async () => {
    mockDb.approvalStep.findMany.mockResolvedValue([]);
    await signOffBudget({ organizationId: ORG, actorUserId: "muthu", actorRole: "ADMIN", source: "ui", budgetId: "b1" });
    expect(mockDb.eventBudget.updateMany.mock.calls[0][0].data).toMatchObject({ signedOffByUserId: "muthu" });
  });
  it("the super admin signs off without the check", async () => {
    await signOffBudget({ organizationId: ORG, actorUserId: "krishna", actorRole: "SUPER_ADMIN", source: "ui", budgetId: "b1" });
    expect(mockDb.approvalStep.findMany).not.toHaveBeenCalled();
    expect(mockDb.eventBudget.updateMany.mock.calls[0][0].data).toMatchObject({ signedOffByUserId: "krishna" });
  });
});
