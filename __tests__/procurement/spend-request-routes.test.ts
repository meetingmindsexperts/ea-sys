/**
 * The spend-request routes through the REAL guard with the service mocked:
 * the flag turns them into 404s, org staff read, only the request grant
 * drafts and submits, an admin without the grant may still cancel, a bad
 * status filter is a logged 400, the side panel's query is validated, and
 * the shared decide route dispatches a SPEND_REQUEST subject to the
 * spend-request service and answers with the request, not a budget.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "127.0.0.1" }));

const mockDb = vi.hoisted(() => ({ approvalRequest: { findFirst: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: vi.fn() }));

const svc = vi.hoisted(() => ({
  listSpendRequests: vi.fn(),
  getSpendRequest: vi.fn(),
  createSpendRequest: vi.fn(),
  updateSpendRequest: vi.fn(),
  submitSpendRequest: vi.fn(),
  transitionSpendRequest: vi.fn(),
  amendSpendRequest: vi.fn(),
  addQuote: vi.fn(),
  removeQuote: vi.fn(),
  previewBudgetCheck: vi.fn(),
  decideSpendRequest: vi.fn(),
}));
vi.mock("@/procurement/services/spend-request-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/procurement/services/spend-request-service")>();
  return { ...real, ...svc };
});
const budgetSvc = vi.hoisted(() => ({ decideBudget: vi.fn(), decideReallocation: vi.fn() }));
vi.mock("@/procurement/services/budget-service", () => budgetSvc);

import { GET as list, POST as create } from "@/app/api/procurement/requests/route";
import { GET as check } from "@/app/api/procurement/requests/budget-check/route";
import { PATCH as patch } from "@/app/api/procurement/requests/[requestId]/route";
import { POST as submit } from "@/app/api/procurement/requests/[requestId]/submit/route";
import { POST as transition } from "@/app/api/procurement/requests/[requestId]/transition/route";
import { POST as addQuote } from "@/app/api/procurement/requests/[requestId]/quotes/route";
import { POST as decide } from "@/app/api/procurement/approvals/[requestId]/decide/route";

const ORG = "org-1";
const user = (over: Record<string, unknown>) => ({ user: { id: "u1", organizationId: ORG, role: "MEMBER", ...over } });
const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = (requestId = "sr1") => ({ params: Promise.resolve({ requestId }) });
const okReq = { ok: true, request: { id: "sr1", budgetId: "b1", requestNo: "PR-2026-0001" } };

beforeEach(() => {
  process.env.PROCUREMENT_MODULE_ENABLED = "true";
  vi.clearAllMocks();
  svc.listSpendRequests.mockResolvedValue([]);
  svc.createSpendRequest.mockResolvedValue(okReq);
  svc.updateSpendRequest.mockResolvedValue(okReq);
  svc.submitSpendRequest.mockResolvedValue(okReq);
  svc.transitionSpendRequest.mockResolvedValue(okReq);
  svc.previewBudgetCheck.mockResolvedValue({ ok: true, request: { check: { status: "WITHIN_BUDGET" } } });
  svc.decideSpendRequest.mockResolvedValue(okReq);
});
afterEach(() => {
  delete process.env.PROCUREMENT_MODULE_ENABLED;
});

describe("GET /api/procurement/requests", () => {
  it("is a 404 while the module is off and a 403 for an org-null caller", async () => {
    delete process.env.PROCUREMENT_MODULE_ENABLED;
    authMock.mockResolvedValue(user({ role: "SUPER_ADMIN" }));
    expect((await list(new NextRequest("http://localhost/api/procurement/requests"))).status).toBe(404);
    process.env.PROCUREMENT_MODULE_ENABLED = "true";
    authMock.mockResolvedValue({ user: { id: "u2", organizationId: null, role: "REGISTRANT" } });
    expect((await list(new NextRequest("http://localhost/api/procurement/requests"))).status).toBe(403);
    expect(svc.listSpendRequests).not.toHaveBeenCalled();
  });
  it("org staff read, the filters reach the service, and a bad status is a logged 400", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    const res = await list(new NextRequest("http://localhost/api/procurement/requests?status=PENDING_APPROVAL&budgetId=b1&mine=1"));
    expect(res.status).toBe(200);
    expect(svc.listSpendRequests).toHaveBeenCalledWith(ORG, { status: "PENDING_APPROVAL", budgetId: "b1", requesterUserId: "u1" });
    const bad = await list(new NextRequest("http://localhost/api/procurement/requests?status=FOO"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "INVALID_FILTER" });
  });
});

describe("POST /api/procurement/requests and the draft writes", () => {
  const body = { budgetId: "b1", lineKey: "k1", title: "LED wall", amount: "5000", currency: "AED" };
  it("needs the request grant: staff without it, admins included, are refused", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    expect((await create(post("/api/procurement/requests", body))).status).toBe(403);
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementSettle: true }));
    expect((await create(post("/api/procurement/requests", body))).status).toBe(403);
    expect(svc.createSpendRequest).not.toHaveBeenCalled();
  });
  it("a grant holder drafts one, the actor carries whether they administer the module, and a bad body is a 400", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementRequest: true }));
    const res = await create(post("/api/procurement/requests", body));
    expect(res.status).toBe(201);
    expect(svc.createSpendRequest).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, actor: { id: "u1", isAdmin: false }, source: "ui", budgetId: "b1", title: "LED wall", currency: "AED" }));
    authMock.mockResolvedValue(user({ role: "ADMIN", procurementRequest: true }));
    await create(post("/api/procurement/requests", body));
    expect(svc.createSpendRequest).toHaveBeenLastCalledWith(expect.objectContaining({ actor: { id: "u1", isAdmin: true } }));
    expect((await create(post("/api/procurement/requests", { ...body, amount: "-1" }))).status).toBe(400);
    expect((await patch(new NextRequest("http://localhost/api/procurement/requests/sr1", { method: "PATCH", body: JSON.stringify({ title: "x" }), headers: { "content-type": "application/json" } }), params())).status).toBe(400);
  });
  it("submit and transition map the service's refusal to its status", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementRequest: true }));
    svc.submitSpendRequest.mockResolvedValue({ ok: false, code: "INCOMPLETE", message: "Not yet", meta: { missing: ["at least one quote"] } });
    const res = await submit(post("/api/procurement/requests/sr1/submit", { expectedVersion: 1 }), params());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "INCOMPLETE", meta: { missing: ["at least one quote"] } });
    svc.transitionSpendRequest.mockResolvedValue({ ok: false, code: "NOT_REQUESTER", message: "No" });
    expect((await transition(post("/api/procurement/requests/sr1/transition", { action: "withdraw", expectedVersion: 1 }), params())).status).toBe(403);
  });
  it("an admin without the request grant may edit a draft and attach a quote; a member without it may not", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    const edit = await patch(new NextRequest("http://localhost/api/procurement/requests/sr1", { method: "PATCH", body: JSON.stringify({ title: "Bigger wall", expectedVersion: 1 }), headers: { "content-type": "application/json" } }), params());
    expect(edit.status).toBe(200);
    expect(svc.updateSpendRequest).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "u1", isAdmin: true }, title: "Bigger wall", expectedVersion: 1 }));
    svc.addQuote.mockResolvedValue(okReq);
    expect((await addQuote(post("/api/procurement/requests/sr1/quotes", { vendorName: "Acme", amount: "100", currency: "AED" }), params())).status).toBe(201);
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    expect((await patch(new NextRequest("http://localhost/api/procurement/requests/sr1", { method: "PATCH", body: JSON.stringify({ title: "x", expectedVersion: 1 }), headers: { "content-type": "application/json" } }), params())).status).toBe(403);
    expect((await addQuote(post("/api/procurement/requests/sr1/quotes", { vendorName: "Acme", amount: "100", currency: "AED" }), params())).status).toBe(403);
    expect(svc.updateSpendRequest).toHaveBeenCalledTimes(1);
    expect(svc.addQuote).toHaveBeenCalledTimes(1);
  });
  it("an admin without the request grant may cancel; a member without it may not", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    const res = await transition(post("/api/procurement/requests/sr1/transition", { action: "cancel", reason: "Postponed", expectedVersion: 2 }), params());
    expect(res.status).toBe(200);
    expect(svc.transitionSpendRequest).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "u1", isAdmin: true }, action: "cancel", reason: "Postponed", expectedVersion: 2 }));
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    expect((await transition(post("/api/procurement/requests/sr1/transition", { action: "cancel", reason: "x", expectedVersion: 2 }), params())).status).toBe(403);
    expect(svc.transitionSpendRequest).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/procurement/requests/budget-check", () => {
  it("validates the query and hands the parsed figures to the preview", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementRequest: true }));
    expect((await check(new NextRequest("http://localhost/api/procurement/requests/budget-check?budgetId=b1&lineKey=k1&amount=abc&currency=AED"))).status).toBe(400);
    const res = await check(new NextRequest("http://localhost/api/procurement/requests/budget-check?budgetId=b1&lineKey=k1&amount=5000&currency=usd&fxRateToReporting=&excludeRequestId=sr1"));
    expect(res.status).toBe(200);
    expect(svc.previewBudgetCheck).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, actorUserId: "u1", budgetId: "b1", lineKey: "k1", amount: "5000", currency: "USD", fxRateToReporting: null, excludeRequestId: "sr1" }));
    // A request is priced in one of the module's five currencies; anything else is a 400 before the service.
    expect((await check(new NextRequest("http://localhost/api/procurement/requests/budget-check?budgetId=b1&lineKey=k1&amount=5000&currency=INR"))).status).toBe(400);
    expect(svc.previewBudgetCheck).toHaveBeenCalledTimes(1);
    svc.previewBudgetCheck.mockResolvedValue({ ok: false, code: "BUDGET_NOT_ACTIVE", message: "Closed", meta: { status: "CLOSED" } });
    expect((await check(new NextRequest("http://localhost/api/procurement/requests/budget-check?budgetId=b1&lineKey=k1&amount=5000&currency=AED"))).status).toBe(409);
  });
});

describe("POST /api/procurement/approvals/[requestId]/decide with a spend request", () => {
  it("dispatches to the spend-request service and answers with the request", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN", procurementApproveCeilingAed: 1_000_000 }));
    mockDb.approvalRequest.findFirst.mockResolvedValue({ subjectType: "SPEND_REQUEST", subjectId: "sr1" });
    const res = await decide(post("/api/procurement/approvals/ar1/decide", { decision: "APPROVED", note: "ok" }), params("ar1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ spendRequest: { id: "sr1" } });
    expect(svc.decideSpendRequest).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, approvalRequestId: "ar1", decision: "APPROVED", note: "ok", decider: expect.objectContaining({ id: "u1" }) }));
    expect(budgetSvc.decideBudget).not.toHaveBeenCalled();
    svc.decideSpendRequest.mockResolvedValue({ ok: false, code: "APPROVAL_FAILED", message: "Only the final approver", meta: { code: "INSUFFICIENT_AUTHORITY" } });
    expect((await decide(post("/api/procurement/approvals/ar1/decide", { decision: "APPROVED" }), params("ar1"))).status).toBe(409);
  });
});
