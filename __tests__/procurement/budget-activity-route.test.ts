/**
 * The activity route through the REAL guard with the service mocked: the flag
 * turns it into a 404, no session is a 401, an org-null account is a 403, org
 * staff read, a foreign budget is a 404, and a thrown read is a logged 500.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/logger", () => ({ apiLogger: logMock }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "127.0.0.1" }));

const svc = vi.hoisted(() => ({ listBudgetActivity: vi.fn() }));
vi.mock("@/procurement/services/budget-activity-service", () => svc);

import { GET } from "@/app/api/procurement/budgets/[budgetId]/activity/route";

const ORG = "org-1";
const user = (over: Record<string, unknown>) => ({ user: { id: "u1", organizationId: ORG, role: "MEMBER", ...over } });
const params = { params: Promise.resolve({ budgetId: "b1" }) };
const req = () => new NextRequest("http://localhost/api/procurement/budgets/b1/activity");
const items = [{ id: "a1", at: "2026-09-14T08:00:00.000Z", entityType: "EventBudget", action: "CREATE", changes: {}, actor: null, title: "Budget created", detail: null }];

beforeEach(() => {
  process.env.PROCUREMENT_MODULE_ENABLED = "true";
  vi.clearAllMocks();
  svc.listBudgetActivity.mockResolvedValue({ ok: true, items, truncated: false });
});
afterEach(() => {
  delete process.env.PROCUREMENT_MODULE_ENABLED;
});

describe("GET /api/procurement/budgets/[budgetId]/activity", () => {
  it("is a 404 while the module is off, even for a super admin", async () => {
    delete process.env.PROCUREMENT_MODULE_ENABLED;
    authMock.mockResolvedValue(user({ role: "SUPER_ADMIN" }));
    expect((await GET(req(), params)).status).toBe(404);
    expect(svc.listBudgetActivity).not.toHaveBeenCalled();
  });
  it("is a 401 with no session and a 403 for an org-null account", async () => {
    authMock.mockResolvedValue(null);
    expect((await GET(req(), params)).status).toBe(401);
    authMock.mockResolvedValue({ user: { id: "r1", organizationId: null, role: "REVIEWER", procurementRequest: true } });
    expect((await GET(req(), params)).status).toBe(403);
    expect(svc.listBudgetActivity).not.toHaveBeenCalled();
  });
  it("org staff read the described rows, bound to their org", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items, truncated: false });
    expect(svc.listBudgetActivity).toHaveBeenCalledWith(ORG, "b1");
  });
  it("a budget outside the org is a logged 404", async () => {
    authMock.mockResolvedValue(user({ role: "ORGANIZER" }));
    svc.listBudgetActivity.mockResolvedValue({ ok: false, code: "BUDGET_NOT_FOUND", message: "The budget was not found." });
    const res = await GET(req(), params);
    expect(res.status).toBe(404);
    expect(logMock.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "BUDGET_NOT_FOUND" }));
  });
  it("a thrown read is a logged 500 that names the route", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    svc.listBudgetActivity.mockRejectedValue(new Error("pool gone"));
    expect((await GET(req(), params)).status).toBe(500);
    expect(logMock.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "procurement/budgets/[budgetId]/activity:read-failed" }));
  });
});
