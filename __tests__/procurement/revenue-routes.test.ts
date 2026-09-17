/**
 * The revenue routes through the REAL guard with the service mocked: reading
 * needs the procurement view AND finance sight (a grant holder whose role
 * sees no money is refused, logged), writing needs authoring AND finance, and
 * service refusals map to their statuses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
const { loggerMock } = vi.hoisted(() => ({ loggerMock: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ apiLogger: loggerMock, dbLogger: loggerMock, authLogger: loggerMock, eventLogger: loggerMock }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "127.0.0.1" }));

const svc = vi.hoisted(() => ({
  getBudgetRevenue: vi.fn(),
  upsertRevenueLine: vi.fn(),
  deleteRevenueLine: vi.fn(),
}));
vi.mock("@/procurement/services/budget-revenue-service", () => svc);

import { GET as revenueGet, POST as revenuePost } from "@/app/api/procurement/budgets/[budgetId]/revenue/route";
import { DELETE as lineDelete, PATCH as linePatch } from "@/app/api/procurement/budgets/[budgetId]/revenue/[lineId]/route";

const ORG = "org-1";
const user = (over: Record<string, unknown>) => ({ user: { id: "u1", organizationId: ORG, role: "MEMBER", ...over } });
const params = { params: Promise.resolve({ budgetId: "b1" }) };
const lineParams = { params: Promise.resolve({ budgetId: "b1", lineId: "r1" }) };
const req = (method: string, body?: unknown) => new NextRequest("http://localhost/api/procurement/budgets/b1/revenue", { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
const validLine = { categoryId: "c-430005", description: "Early bird physicians", qty: 200, unitAmount: "1500", transactionCurrency: "USD" };

beforeEach(() => {
  process.env.PROCUREMENT_MODULE_ENABLED = "true";
  vi.clearAllMocks();
  svc.getBudgetRevenue.mockResolvedValue({ ok: true, value: { lines: [] } });
  svc.upsertRevenueLine.mockResolvedValue({ ok: true, value: { id: "r1" } });
  svc.deleteRevenueLine.mockResolvedValue({ ok: true, value: { id: "r1" } });
});
afterEach(() => {
  delete process.env.PROCUREMENT_MODULE_ENABLED;
});

describe("GET revenue", () => {
  it("is read by a budget reader who sees money", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    const res = await revenueGet(req("GET"), params);
    expect(res.status).toBe(200);
    expect(svc.getBudgetRevenue).toHaveBeenCalledWith(ORG, "b1");
  });
  it("refuses a grant holder whose role sees no money, before any read, and logs it", async () => {
    authMock.mockResolvedValue(user({ role: "CRM_USER", procurementRequest: true }));
    const res = await revenueGet(req("GET"), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FINANCE_REQUIRED" });
    expect(svc.getBudgetRevenue).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "procurement/budgets/[budgetId]/revenue:finance-refused", role: "CRM_USER" }));
  });
  it("maps a missing budget to 404", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    svc.getBudgetRevenue.mockResolvedValue({ ok: false, code: "BUDGET_NOT_FOUND", message: "gone" });
    expect((await revenueGet(req("GET"), params)).status).toBe(404);
  });
});

describe("writing revenue lines", () => {
  it("lets an author add a line and refuses a reader", async () => {
    authMock.mockResolvedValue(user({ role: "ORGANIZER" }));
    const res = await revenuePost(req("POST", validLine), params);
    expect(res.status).toBe(201);
    expect(svc.upsertRevenueLine).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, actorUserId: "u1", source: "ui", budgetId: "b1", categoryId: "c-430005", description: "Early bird physicians" }));
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    expect((await revenuePost(req("POST", validLine), params)).status).toBe(403);
  });
  it("refuses a body without an account or a description", async () => {
    authMock.mockResolvedValue(user({ role: "ORGANIZER" }));
    expect((await revenuePost(req("POST", { description: "x" }), params)).status).toBe(400);
    expect(svc.upsertRevenueLine).not.toHaveBeenCalled();
  });
  it("maps a non-draft refusal to 409 on edit and removes on a draft", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    svc.upsertRevenueLine.mockResolvedValue({ ok: false, code: "INVALID_STATUS", message: "draft only" });
    expect((await linePatch(req("PATCH", { unitAmount: "1800" }), lineParams)).status).toBe(409);
    const del = await lineDelete(req("DELETE"), lineParams);
    expect(del.status).toBe(200);
    expect(svc.deleteRevenueLine).toHaveBeenCalledWith({ organizationId: ORG, actorUserId: "u1", source: "ui", budgetId: "b1", lineId: "r1" });
  });
});
