/**
 * The grant matrix per route, through the REAL guard (denyNonProcurement +
 * the visibility predicates) with the services mocked: who may read, author,
 * decide, sign off and reopen, and that the flag turns everything into a 404.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
// All four real loggers, not just the one this file uses. `route-helpers.ts`
// now imports `@/lib/db` (the guard reads custom-role permissions), and `db`
// imports `dbLogger`, so a mock naming a single export breaks the moment the
// import graph widens — which is exactly what happened on Sep 16 2026.
// Hoisted WITH the vi.mock factories, which run above every plain top-level
// const in the file. A bare `const` here is read before it exists and the
// whole suite fails to load rather than failing an assertion.
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: loggerMock, dbLogger: loggerMock, authLogger: loggerMock, eventLogger: loggerMock,
}));
// The guard resolves permissions on every procurement request; these suites
// exercise the LEGACY arm, so an empty set keeps today's behaviour exactly.
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "127.0.0.1" }));

const svc = vi.hoisted(() => ({
  listBudgets: vi.fn().mockResolvedValue([]),
  invalidBudgetStatusFilter: (s: string | undefined) => s !== undefined && !["DRAFT", "UNDER_REVIEW", "APPROVED", "ACTIVE", "FROZEN", "CLOSED", "ARCHIVED"].includes(s),
  createBudget: vi.fn().mockResolvedValue({ ok: true, budget: { id: "b1" } }),
  getBudget: vi.fn().mockResolvedValue({ ok: true, budget: { id: "b1" } }),
  updateBudgetHeader: vi.fn(),
  discardDraftBudget: vi.fn(),
  decideBudget: vi.fn().mockResolvedValue({ ok: true, budget: { id: "b1" } }),
  freezeBudget: vi.fn().mockResolvedValue({ ok: true, budget: { id: "b1" } }),
  unfreezeBudget: vi.fn().mockResolvedValue({ ok: true, budget: { id: "b1" } }),
  closeBudget: vi.fn().mockResolvedValue({ ok: false, code: "VARIANCE_NOTES_REQUIRED", message: "notes", meta: { lineKeys: ["k"] } }),
  signOffBudget: vi.fn().mockResolvedValue({ ok: true, budget: { id: "b1" } }),
  reopenBudget: vi.fn().mockResolvedValue({ ok: true, budget: { id: "b1" } }),
}));
vi.mock("@/procurement/services/budget-service", () => svc);

import { GET as listGet, POST as createPost } from "@/app/api/procurement/budgets/route";
import { POST as decidePost } from "@/app/api/procurement/budgets/[budgetId]/decide/route";
import { POST as transitionPost } from "@/app/api/procurement/budgets/[budgetId]/transition/route";

const ORG = "org-1";
const user = (over: Record<string, unknown>) => ({ user: { id: "u1", organizationId: ORG, role: "MEMBER", ...over } });
const params = { params: Promise.resolve({ budgetId: "b1" }) };
const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(() => {
  process.env.PROCUREMENT_MODULE_ENABLED = "true";
  vi.clearAllMocks();
  svc.createBudget.mockResolvedValue({ ok: true, budget: { id: "b1" } });
});
afterEach(() => {
  delete process.env.PROCUREMENT_MODULE_ENABLED;
});

describe("procurement routes: flag and authentication", () => {
  it("is a 404 for everyone while the module is off, an admin included", async () => {
    delete process.env.PROCUREMENT_MODULE_ENABLED;
    authMock.mockResolvedValue(user({ role: "SUPER_ADMIN" }));
    expect((await listGet(new NextRequest("http://localhost/api/procurement/budgets"))).status).toBe(404);
  });
  it("is a 401 with no session", async () => {
    authMock.mockResolvedValue(null);
    expect((await listGet(new NextRequest("http://localhost/api/procurement/budgets"))).status).toBe(401);
  });
  it("refuses an org-null account even with a grant", async () => {
    authMock.mockResolvedValue({ user: { id: "r1", organizationId: null, role: "REVIEWER", procurementRequest: true } });
    expect((await listGet(new NextRequest("http://localhost/api/procurement/budgets"))).status).toBe(403);
  });
});

describe("procurement routes: reading and authoring", () => {
  it("MEMBER reads the list but cannot create; ORGANIZER creates", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    expect((await listGet(new NextRequest("http://localhost/api/procurement/budgets"))).status).toBe(200);
    expect((await createPost(post("/api/procurement/budgets", { eventId: "e1", reportingCurrency: "AED" }))).status).toBe(403);
    expect(svc.createBudget).not.toHaveBeenCalled();
    authMock.mockResolvedValue(user({ role: "ORGANIZER" }));
    const res = await createPost(post("/api/procurement/budgets", { eventId: "e1", reportingCurrency: "AED" }));
    expect(res.status).toBe(201);
    expect(svc.createBudget).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, actorUserId: "u1", source: "ui", eventId: "e1" }));
  });
  it("a MEMBER holding a custom role AUTHORS, which no role grants (the project-manager case)", async () => {
    // THE ORDERING PIN. The guard must resolve permissions BEFORE
    // `denyNonProcurement` judges the need. The first cut resolved them after:
    // everything compiled, the whole suite passed, and the feature was
    // unreachable because the need check saw `undefined` and fell through to
    // the legacy arm. Move that call back above the read and this test fails.
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementPermissions: ["procurement.budgets.create"] }));
    expect((await listGet(new NextRequest("http://localhost/api/procurement/budgets"))).status).toBe(200);
    const res = await createPost(post("/api/procurement/budgets", { eventId: "e1", reportingCurrency: "AED" }));
    expect(res.status).toBe(201);
    expect(svc.createBudget).toHaveBeenCalled();
  });

  it("a custom role unlocks only its own key: budgets.create is not authority to decide", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementPermissions: ["procurement.budgets.create"] }));
    // `approve` needs the key AND a ceiling on the person (D3); this person has neither.
    expect((await decidePost(post("/api/procurement/budgets/b1/decide", { decision: "APPROVED" }), { params: Promise.resolve({ budgetId: "b1" }) })).status).toBe(403);
  });

  it("a CRM_USER holding only the request grant reads but does not author", async () => {
    authMock.mockResolvedValue(user({ role: "CRM_USER", procurementRequest: true }));
    expect((await listGet(new NextRequest("http://localhost/api/procurement/budgets"))).status).toBe(200);
    expect((await createPost(post("/api/procurement/budgets", { eventId: "e1", reportingCurrency: "AED" }))).status).toBe(403);
  });
  it("a bad body is a logged 400, never a service call", async () => {
    authMock.mockResolvedValue(user({ role: "ORGANIZER" }));
    expect((await createPost(post("/api/procurement/budgets", { eventId: "e1", reportingCurrency: "XXX" }))).status).toBe(400);
    expect(svc.createBudget).not.toHaveBeenCalled();
  });
  it("maps a service refusal onto its status and carries the code", async () => {
    authMock.mockResolvedValue(user({ role: "ORGANIZER" }));
    svc.createBudget.mockResolvedValue({ ok: false, code: "EVENT_CODE_REQUIRED", message: "no code" });
    const res = await createPost(post("/api/procurement/budgets", { eventId: "e1", reportingCurrency: "AED" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "EVENT_CODE_REQUIRED" });
  });
});

describe("procurement routes: deciding and the lifecycle moves", () => {
  it("only an approval grant reaches decide; the settle grant and a plain admin do not", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementSettle: true }));
    expect((await decidePost(post("/api/procurement/budgets/b1/decide", { decision: "APPROVED" }), params)).status).toBe(403);
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    expect((await decidePost(post("/api/procurement/budgets/b1/decide", { decision: "APPROVED" }), params)).status).toBe(403);
    authMock.mockResolvedValue(user({ role: "ADMIN", procurementApproveCeilingAed: 1_000_000 }));
    expect((await decidePost(post("/api/procurement/budgets/b1/decide", { decision: "APPROVED" }), params)).status).toBe(200);
    expect(svc.decideBudget).toHaveBeenCalledWith(expect.objectContaining({ decider: expect.objectContaining({ id: "u1", procurementApproveCeilingAed: 1_000_000 }) }));
  });
  it("transition: freeze is the author's, sign-off the settle grant's, reopen the admin's", async () => {
    authMock.mockResolvedValue(user({ role: "ORGANIZER" }));
    expect((await transitionPost(post("/api/procurement/budgets/b1/transition", { action: "freeze" }), params)).status).toBe(200);
    expect((await transitionPost(post("/api/procurement/budgets/b1/transition", { action: "sign-off" }), params)).status).toBe(403);
    expect((await transitionPost(post("/api/procurement/budgets/b1/transition", { action: "reopen", reason: "x" }), params)).status).toBe(403);
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementSettle: true }));
    expect((await transitionPost(post("/api/procurement/budgets/b1/transition", { action: "sign-off" }), params)).status).toBe(200);
    expect(svc.signOffBudget).toHaveBeenCalledTimes(1);
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    expect((await transitionPost(post("/api/procurement/budgets/b1/transition", { action: "reopen", reason: "audit" }), params)).status).toBe(200);
    expect(svc.reopenBudget).toHaveBeenCalledWith(expect.objectContaining({ reason: "audit" }));
  });
  it("close surfaces the lines that still need a variance note as 422 with their keys", async () => {
    authMock.mockResolvedValue(user({ role: "ORGANIZER" }));
    const res = await transitionPost(post("/api/procurement/budgets/b1/transition", { action: "close" }), params);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "VARIANCE_NOTES_REQUIRED", meta: { lineKeys: ["k"] } });
  });
});
