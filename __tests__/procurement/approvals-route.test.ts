/**
 * The inbox route: the caller's scope, the names resolved for the rows, and
 * a reallocation's move carrying the two lines' descriptions so the inbox
 * reads without opening the budget.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));

const mockDb = vi.hoisted(() => ({
  approvalRequest: { findMany: vi.fn() },
  eventBudget: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  budgetLine: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { GET } from "@/app/api/procurement/approvals/route";

const ORG = "org-1";
const dec = (s: string) => ({ toString: () => s });

beforeEach(() => {
  process.env.PROCUREMENT_MODULE_ENABLED = "true";
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "approver", organizationId: ORG, role: "ADMIN", procurementApproveCeilingAed: 500_000 } });
  mockDb.approvalRequest.findMany.mockResolvedValue([
    { id: "r-move", subjectType: "BUDGET_REALLOCATION", subjectId: "b1", amountAed: dec("1836.2500"), amount: dec("500.0000"), currency: "USD", status: "PENDING", requesterUserId: "author", reason: "Catering", payload: { fromLineKey: "k-hall", toLineKey: "k-fnb", amount: "500.0000", reportingToAedRate: "3.6725", rateSource: "peg" }, decidedAt: null, createdAt: new Date("2026-09-14T08:00:00Z"), steps: [{ id: "s1", sequence: 1, assigneeUserId: "approver", delegateUserId: null, dueAt: null, status: "PENDING", decidedByUserId: null, decidedAt: null, note: null }] },
    { id: "r-budget", subjectType: "BUDGET", subjectId: "b1", amountAed: dec("134882.0000"), amount: dec("36725.0000"), currency: "USD", status: "PENDING", requesterUserId: "author", reason: null, payload: { reportingToAedRate: "3.6725", rateSource: "peg" }, decidedAt: null, createdAt: new Date("2026-09-14T07:00:00Z"), steps: [] },
  ]);
  mockDb.eventBudget.findMany.mockResolvedValue([{ id: "b1", eventCode: "TW2SE26", versionNo: 1, status: "ACTIVE", reportingCurrency: "USD", event: { name: "Sandbox" } }]);
  mockDb.user.findMany.mockResolvedValue([{ id: "author", firstName: "Ada", lastName: "Author" }, { id: "approver", firstName: "Bob", lastName: "Boss" }]);
  mockDb.budgetLine.findMany.mockResolvedValue([{ budgetId: "b1", lineKey: "k-hall", description: "Hall hire" }, { budgetId: "b1", lineKey: "k-fnb", description: "Food & Beverage" }]);
});
afterEach(() => {
  delete process.env.PROCUREMENT_MODULE_ENABLED;
});

describe("GET /api/procurement/approvals", () => {
  it("defaults to the inbox scope: pending requests with a step on the caller", async () => {
    const res = await GET(new NextRequest("http://localhost/api/procurement/approvals"));
    expect(res.status).toBe(200);
    const where = mockDb.approvalRequest.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ organizationId: ORG, status: "PENDING", steps: { some: { status: "PENDING", OR: [{ assigneeUserId: "approver" }, { delegateUserId: "approver" }] } } });
    expect((await res.json()).scope).toBe("inbox");
  });

  it("scope=mine lists the caller's own requests", async () => {
    await GET(new NextRequest("http://localhost/api/procurement/approvals?scope=mine"));
    expect(mockDb.approvalRequest.findMany.mock.calls[0][0].where).toEqual({ organizationId: ORG, requesterUserId: "approver" });
  });

  it("names the requester, the assignee, the budget, and the two lines of a reallocation's move", async () => {
    const body = await (await GET(new NextRequest("http://localhost/api/procurement/approvals"))).json();
    const [move, budget] = body.requests;
    expect(move).toMatchObject({
      amountAed: "1836.2500",
      amount: "500.0000",
      requesterName: "Ada Author",
      budget: { id: "b1", eventCode: "TW2SE26", event: { name: "Sandbox" } },
      move: { fromLineKey: "k-hall", toLineKey: "k-fnb", amount: "500.0000", fromDescription: "Hall hire", toDescription: "Food & Beverage" },
      steps: [{ id: "s1", assigneeName: "Bob Boss" }],
    });
    expect(budget.move).toBeNull();
    // The line lookup is org-bound and asks only for the keys the moves name.
    expect(mockDb.budgetLine.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: ORG, OR: [{ budgetId: "b1", lineKey: "k-hall" }, { budgetId: "b1", lineKey: "k-fnb" }] } }));
  });

  it("a reallocation whose payload carries no move reads as none, and no line lookup runs", async () => {
    mockDb.approvalRequest.findMany.mockResolvedValue([{ id: "r-odd", subjectType: "BUDGET_REALLOCATION", subjectId: "b1", amountAed: dec("1"), amount: null, currency: null, status: "PENDING", requesterUserId: "author", reason: null, payload: { amount: 5 }, decidedAt: null, createdAt: new Date(), steps: [] }]);
    const body = await (await GET(new NextRequest("http://localhost/api/procurement/approvals"))).json();
    expect(body.requests[0].move).toBeNull();
    expect(mockDb.budgetLine.findMany).not.toHaveBeenCalled();
  });

  it("is a 404 with the flag off and a 403 for an org-null caller", async () => {
    delete process.env.PROCUREMENT_MODULE_ENABLED;
    expect((await GET(new NextRequest("http://localhost/api/procurement/approvals"))).status).toBe(404);
    process.env.PROCUREMENT_MODULE_ENABLED = "true";
    authMock.mockResolvedValue({ user: { id: "r1", organizationId: null, role: "REVIEWER" } });
    expect((await GET(new NextRequest("http://localhost/api/procurement/approvals"))).status).toBe(403);
  });
});
