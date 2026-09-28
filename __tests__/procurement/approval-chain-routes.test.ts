/**
 * The approval chain's routes (Sep 28, 2026), through the REAL guard:
 *  - the chain is saved by the super admin only; anyone with procurement
 *    access reads it;
 *  - the decide route no longer demands an approval grant up front, because
 *    the final approver's stand-in may hold none: the settle holder reaches
 *    the service, which judges them from the row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
const { loggerMock } = vi.hoisted(() => ({ loggerMock: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ apiLogger: loggerMock, dbLogger: loggerMock, authLogger: loggerMock, eventLogger: loggerMock }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "127.0.0.1" }));

const chainSvc = vi.hoisted(() => ({
  getApprovalChain: vi.fn().mockResolvedValue({ chain: null, candidates: [], updatedAt: null }),
  saveApprovalChain: vi.fn().mockResolvedValue({ ok: true, view: { chain: { levels: ["a", "b"], standInUserId: null }, candidates: [], updatedAt: null } }),
}));
vi.mock("@/procurement/services/approval-chain-service", () => chainSvc);

const mockDb = vi.hoisted(() => ({ approvalRequest: { findFirst: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
const spendSvc = vi.hoisted(() => ({ decideSpendRequest: vi.fn().mockResolvedValue({ ok: true, request: { id: "sr1" } }) }));
vi.mock("@/procurement/services/spend-request-service", () => spendSvc);
vi.mock("@/procurement/services/budget-service", () => ({ decideBudget: vi.fn(), decideReallocation: vi.fn() }));

import { GET as chainGet, PUT as chainPut } from "@/app/api/procurement/approval-chain/route";
import { POST as decidePost } from "@/app/api/procurement/approvals/[requestId]/decide/route";

const ORG = "org-1";
const user = (over: Record<string, unknown>) => ({ user: { id: "u1", organizationId: ORG, role: "MEMBER", ...over } });
const put = (body: unknown) => new NextRequest("http://localhost/api/procurement/approval-chain", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  process.env.PROCUREMENT_MODULE_ENABLED = "true";
  vi.clearAllMocks();
});
afterEach(() => {
  delete process.env.PROCUREMENT_MODULE_ENABLED;
});

describe("/api/procurement/approval-chain", () => {
  it("anyone with procurement access reads it", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN", procurementSettle: true }));
    expect((await chainGet()).status).toBe(200);
  });
  it("only the super admin saves it; an admin, even the final approver, is refused before the service", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN", procurementApproveUnlimited: true }));
    expect((await chainPut(put({ levels: ["a", "b"], standInUserId: null }))).status).toBe(403);
    expect(chainSvc.saveApprovalChain).not.toHaveBeenCalled();
    authMock.mockResolvedValue(user({ role: "SUPER_ADMIN" }));
    expect((await chainPut(put({ levels: ["a", "b"], standInUserId: "c" }))).status).toBe(200);
    expect(chainSvc.saveApprovalChain).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, actorUserId: "u1", config: { levels: ["a", "b"], standInUserId: "c" } }));
  });
  it("turning it off drops the stand-in, and a refused chain maps to 422", async () => {
    authMock.mockResolvedValue(user({ role: "SUPER_ADMIN" }));
    await chainPut(put({ levels: [], standInUserId: "c" }));
    expect(chainSvc.saveApprovalChain.mock.calls[0][0].config).toEqual({ levels: [], standInUserId: null });
    chainSvc.saveApprovalChain.mockResolvedValueOnce({ ok: false, code: "FINAL_NOT_UNLIMITED", message: "no" });
    expect((await chainPut(put({ levels: ["a", "b"], standInUserId: null }))).status).toBe(422);
    expect((await chainPut(put({ levels: ["a", "b", "c", "d", "e"], standInUserId: null }))).status).toBe(400);
  });
});

describe("the decide route and the stand-in", () => {
  it("a settle holder with no approval grant reaches the service, which judges the decision", async () => {
    mockDb.approvalRequest.findFirst.mockResolvedValue({ subjectType: "SPEND_REQUEST", subjectId: "sr1" });
    authMock.mockResolvedValue(user({ role: "ADMIN", procurementSettle: true }));
    const res = await decidePost(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify({ decision: "APPROVED" }), headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ requestId: "ar1" }) });
    expect(res.status).toBe(200);
    expect(spendSvc.decideSpendRequest).toHaveBeenCalledWith(expect.objectContaining({ approvalRequestId: "ar1", decider: expect.objectContaining({ id: "u1" }) }));
  });
  it("someone without procurement access is still refused at the door", async () => {
    // A MEMBER reads Budgets and so reaches the service, which refuses a non-assignee; the desk role never gets that far.
    authMock.mockResolvedValue(user({ role: "ONSITE" }));
    const res = await decidePost(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify({ decision: "APPROVED" }), headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ requestId: "ar1" }) });
    expect(res.status).toBe(403);
    expect(spendSvc.decideSpendRequest).not.toHaveBeenCalled();
  });
});
