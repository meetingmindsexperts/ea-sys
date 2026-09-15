/**
 * /api/activity: the procurement scope split (Sep 15, 2026, owner: "keep
 * budget activity separate from event activity").
 *
 * The Budget & Procurement services write to the shared AuditLog, and until
 * this split their rows rendered in the Changes feed between registrations and
 * speakers, raw. The default query must EXCLUDE the procurement set;
 * `?scope=procurement` must INCLUDE only it behind the module flag and the
 * real `canViewProcurement`, resolve each row's subject once per family,
 * org-bound, and run the module's describer server-side so the client gets a
 * sentence.
 *
 * `canViewProcurement` and `PROCUREMENT_AUDIT_ENTITY_TYPES` are REAL here (the
 * predicate is the thing under test). The mutation that matters is reverting
 * the route's `notIn` to the HR set alone; the default-scope assertions below
 * fail on it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HR_AUDIT_ENTITY_TYPES } from "@/lib/hr-visibility";
import { PROCUREMENT_AUDIT_ENTITY_TYPES } from "@/lib/procurement-visibility";

const { mockDb, mockAuth, mockLogger, mockProcEnabled, mockCanView, realPredicate } = vi.hoisted(() => {
  const finder = () => ({ findMany: vi.fn() });
  return {
    mockDb: {
      auditLog: finder(),
      employee: finder(),
      eventBudget: finder(),
      spendRequest: finder(),
      commitment: finder(),
      supplier: finder(),
      budgetProduct: finder(),
      budgetCategory: finder(),
      budgetTemplate: finder(),
      budgetLine: finder(),
      user: finder(),
    },
    mockAuth: vi.fn(),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    mockProcEnabled: vi.fn(() => true),
    // Defaults to the REAL predicate (captured by the mock factory below);
    // one test forces a refusal to pin the wall's mechanics.
    mockCanView: vi.fn(),
    realPredicate: { fn: null as null | ((u: unknown) => boolean) },
  };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/module-flags", () => ({
  isHrModuleEnabled: () => true,
  isProcurementModuleEnabled: () => mockProcEnabled(),
}));
vi.mock("@/lib/procurement-visibility", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/procurement-visibility")>();
  realPredicate.fn = real.canViewProcurement as (u: unknown) => boolean;
  return { ...real, canViewProcurement: (u: unknown) => mockCanView(u) };
});

import { GET } from "@/app/api/activity/route";

const PROC = [...PROCUREMENT_AUDIT_ENTITY_TYPES];
const EXCLUDED = [...HR_AUDIT_ENTITY_TYPES, ...PROC];
const PROC_TABLES = ["eventBudget", "spendRequest", "commitment", "supplier", "budgetProduct", "budgetCategory", "budgetTemplate", "budgetLine", "user"] as const;

const req = (qs = "") => new Request(`http://localhost/api/activity${qs}`);

const user = (role: string, grants: Record<string, unknown> = {}) => ({
  user: { id: "u1", role, organizationId: "org1", ...grants },
});

const whereOf = () =>
  (mockDb.auditLog.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;

const now = new Date("2026-09-15T08:00:00.000Z");
const auditRow = (over: Partial<{ id: string; action: string; entityType: string; entityId: string; changes: Record<string, unknown> }>) => ({
  id: "a1",
  action: "CREATE",
  entityType: "EventBudget",
  entityId: "b1",
  changes: {},
  createdAt: now,
  user: null,
  event: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockProcEnabled.mockReturnValue(true);
  // Synchronous on purpose: the route reads the predicate with `!`, so a
  // Promise-returning mock would read as "allowed" whatever it resolves to.
  mockCanView.mockImplementation((u) => realPredicate.fn!(u));
  mockDb.auditLog.findMany.mockResolvedValue([]);
  mockDb.employee.findMany.mockResolvedValue([]);
  for (const t of PROC_TABLES) mockDb[t].findMany.mockResolvedValue([]);
});

describe("GET /api/activity: default scope excludes procurement rows", () => {
  it("an ADMIN's default feed carries neither HR nor procurement rows", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(whereOf().entityType).toEqual({ notIn: EXCLUDED });
    for (const t of PROC) expect(EXCLUDED).toContain(t);
  });

  it("an explicit procurement entityType filter narrows WITHIN the exclusion; it cannot lift it", async () => {
    mockAuth.mockResolvedValue(user("SUPER_ADMIN"));
    await GET(req("?entityType=EventBudget"));
    expect(whereOf().entityType).toEqual({ notIn: EXCLUDED, equals: "EventBudget" });
  });

  it("never touches a procurement table or the describer in the default scope", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    mockDb.auditLog.findMany.mockResolvedValue([auditRow({ entityType: "Registration", entityId: "r1" })]);
    const res = await GET(req());
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect("title" in body[0]).toBe(false);
    expect("subjectName" in body[0]).toBe(false);
    for (const t of PROC_TABLES) expect(mockDb[t].findMany).not.toHaveBeenCalled();
  });

  it("the HR scope is unchanged by the split: HR types only, no procurement lookups", async () => {
    mockAuth.mockResolvedValue(user("SUPER_ADMIN"));
    await GET(req("?scope=hr"));
    expect(whereOf().entityType).toEqual({ in: [...HR_AUDIT_ENTITY_TYPES] });
    for (const t of PROC_TABLES) expect(mockDb[t].findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/activity?scope=procurement: the two walls", () => {
  it("404 + logged when the module is switched off, even for SUPER_ADMIN, and no query runs", async () => {
    mockProcEnabled.mockReturnValue(false);
    mockAuth.mockResolvedValue(user("SUPER_ADMIN"));
    const res = await GET(req("?scope=procurement"));
    expect(res.status).toBe(404);
    expect(mockDb.auditLog.findMany).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "activity:procurement-module-disabled" }));
  });

  it("403 + logged when canViewProcurement refuses, and no query runs (fail closed)", async () => {
    // Every role the page admits may read budgets today, so the wall is only
    // reachable if the page gate is widened; the predicate, not the page, is
    // the control, so its refusal path is pinned by forcing it here.
    mockCanView.mockReturnValue(false);
    mockAuth.mockResolvedValue(user("ADMIN"));
    const res = await GET(req("?scope=procurement"));
    expect(res.status).toBe(403);
    expect(mockDb.auditLog.findMany).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "activity:procurement-scope-forbidden", role: "ADMIN", userId: "u1" }),
    );
  });

  it("the real predicate admits ADMIN and SUPER_ADMIN without a grant, and a MEMBER with one", () => {
    const real = realPredicate.fn!;
    expect(real({ role: "ADMIN" })).toBe(true);
    expect(real({ role: "SUPER_ADMIN" })).toBe(true);
    expect(real({ role: "MEMBER", procurementRequest: true })).toBe(true);
    expect(real({ role: "CRM_USER" })).toBe(false);
  });

  it("200 for an ADMIN, querying ONLY the procurement types", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    const res = await GET(req("?scope=procurement"));
    expect(res.status).toBe(200);
    expect(whereOf()).toMatchObject({ organizationId: "org1", entityType: { in: PROC } });
  });

  it("an entityType filter inside the procurement scope stays inside it", async () => {
    mockAuth.mockResolvedValue(user("SUPER_ADMIN"));
    await GET(req("?scope=procurement&entityType=SpendRequest"));
    expect(whereOf().entityType).toEqual({ in: PROC, equals: "SpendRequest" });
  });

  it("an entityType filter naming an HR type inside the procurement scope is the empty set, not a leak", async () => {
    mockAuth.mockResolvedValue(user("SUPER_ADMIN"));
    await GET(req("?scope=procurement&entityType=Employee"));
    expect(whereOf().entityType).toEqual({ in: PROC, equals: "Employee" });
    expect(mockDb.employee.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/activity?scope=procurement: subject and sentence resolution", () => {
  it("resolves every family once, org-bound, and writes the describer's sentence per row", async () => {
    mockAuth.mockResolvedValue(user("SUPER_ADMIN"));
    mockDb.auditLog.findMany.mockResolvedValue([
      auditRow({ id: "a1", entityType: "EventBudget", entityId: "b1", action: "SUBMIT", changes: { amountAed: "36000.0000", reportingToAedRate: "1" } }),
      auditRow({ id: "a2", entityType: "BudgetLine", entityId: "l1", action: "CREATE", changes: { budgetId: "b1", description: "Audio visual", planned: "36000.0000" } }),
      auditRow({ id: "a3", entityType: "ApprovalRequest", entityId: "ar1", action: "APPROVAL_REQUESTED", changes: { subjectType: "SPEND_REQUEST", subjectId: "sr1", amountAed: "5000.0000", assigneeUserId: "u2", superseded: [] } }),
      auditRow({ id: "a4", entityType: "ApprovalRequest", entityId: "ar2", action: "APPROVAL_GRANTED", changes: { subjectType: "BUDGET_REALLOCATION", subjectId: "b1", amountAed: "9000.0000", note: "ok" } }),
      auditRow({ id: "a5", entityType: "SpendRequest", entityId: "sr1", action: "SUBMIT", changes: { requestNo: "PR-2026-0001", budgetId: "b1", amountAed: "5000.0000", budgetCheck: "WITHIN_BUDGET", exception: false } }),
      auditRow({ id: "a6", entityType: "Commitment", entityId: "c1", action: "CONFIRM_RECEIPT", changes: { commitmentNo: "PO-2026-0001", receivedByUserId: "u3", amountAed: "60000.0000" } }),
      auditRow({ id: "a7", entityType: "Supplier", entityId: "s1", action: "APPROVE", changes: { code: "GULFAV", note: null } }),
      auditRow({ id: "a8", entityType: "BudgetProduct", entityId: "p1", action: "ARCHIVE", changes: { sku: "AV-001", fields: ["isActive"], isActive: false } }),
      auditRow({ id: "a9", entityType: "BudgetCategory", entityId: "cat1", action: "CREATE", changes: { code: "AV", name: "Audio visual" } }),
      auditRow({ id: "a10", entityType: "BudgetTemplate", entityId: "t1", action: "ADD_LINE", changes: { lineId: null } }),
      auditRow({ id: "a11", entityType: "EventBudget", entityId: "b1", action: "REALLOCATE", changes: { fromLineKey: "k-venue", toLineKey: "k-av", amount: "500.0000", authority: "OWNER" } }),
    ]);
    mockDb.eventBudget.findMany.mockResolvedValue([{ id: "b1", eventCode: "HM2026", versionNo: 2 }]);
    mockDb.spendRequest.findMany.mockResolvedValue([{ id: "sr1", requestNo: "PR-2026-0001", title: "LED wall" }]);
    mockDb.commitment.findMany.mockResolvedValue([{ id: "c1", commitmentNo: "PO-2026-0001", spendRequest: { title: "Stage" } }]);
    mockDb.supplier.findMany.mockResolvedValue([{ id: "s1", displayName: "Gulf AV" }]);
    mockDb.budgetProduct.findMany.mockResolvedValue([{ id: "p1", name: "LED wall panel" }]);
    mockDb.budgetCategory.findMany.mockResolvedValue([{ id: "cat1", name: "Audio visual" }]);
    mockDb.budgetTemplate.findMany.mockResolvedValue([{ id: "t1", name: "Conference standard" }]);
    mockDb.user.findMany.mockResolvedValue([
      { id: "u2", firstName: "Lina", lastName: "H", email: "l@x.test" },
      { id: "u3", firstName: "", lastName: "", email: "muthu@x.test" },
    ]);
    mockDb.budgetLine.findMany.mockResolvedValue([
      { lineKey: "k-venue", description: "Venue hire" },
      { lineKey: "k-av", description: "Audio visual" },
    ]);

    const res = await GET(req("?scope=procurement"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; subjectName: string | null; title: string; detail: string | null }>;

    // One query per family, every one org-bound.
    for (const t of PROC_TABLES) {
      expect(mockDb[t].findMany, t).toHaveBeenCalledTimes(1);
      const arg = mockDb[t].findMany.mock.calls[0][0] as { where: { organizationId: string } };
      expect(arg.where.organizationId, t).toBe("org1");
    }
    const budgetArg = mockDb.eventBudget.findMany.mock.calls[0][0] as { where: { id: { in: string[] } } };
    expect(budgetArg.where.id.in).toEqual(["b1"]);
    const requestArg = mockDb.spendRequest.findMany.mock.calls[0][0] as { where: { id: { in: string[] } } };
    expect([...requestArg.where.id.in].sort()).toEqual(["sr1"]);
    const userArg = mockDb.user.findMany.mock.calls[0][0] as { where: { id: { in: string[] } } };
    expect([...userArg.where.id.in].sort()).toEqual(["u2", "u3"]);

    expect(body.map((r) => [r.id, r.subjectName, r.title, r.detail])).toEqual([
      ["a1", "HM2026 v2", "Submitted for approval", "AED 36,000.00"],
      ["a2", "HM2026 v2", "Line added: Audio visual", "planned 36,000.00"],
      ["a3", "PR-2026-0001 · LED wall", "Routed to Lina H for approval", "AED 5,000.00"],
      ["a4", "HM2026 v2 (move between lines)", "Approval granted", "AED 9,000.00, note: ok"],
      ["a5", "PR-2026-0001 · LED wall", "Request submitted", "AED 5,000.00, within budget"],
      ["a6", "PO-2026-0001 · Stage", "Receipt confirmed", "AED 60,000.00, received by muthu@x.test"],
      ["a7", "Gulf AV", "Supplier approved", "code GULFAV"],
      ["a8", "LED wall panel", "Product archived", "SKU AV-001"],
      ["a9", "Audio visual", "Category added", "code AV"],
      ["a10", "Conference standard", "Template line added", null],
      ["a11", "HM2026 v2", "Amount moved between lines", "500.00 from Venue hire to Audio visual, within the owner's ten percent"],
    ]);
  });

  it("falls back to the payload's own numbers when the row is gone, and skips families the page does not carry", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    mockDb.auditLog.findMany.mockResolvedValue([
      auditRow({ id: "a1", entityType: "SpendRequest", entityId: "gone", action: "CANCEL", changes: { requestNo: "PR-2026-0009", reason: "Vendor withdrew" } }),
      auditRow({ id: "a2", entityType: "Commitment", entityId: "gone2", action: "CANCEL", changes: { commitmentNo: "PO-2026-0002", released: "5000.0000", reason: "Duplicate" } }),
      auditRow({ id: "a3", entityType: "EventBudget", entityId: "org:org1", action: "EXPORT", changes: { format: "csv", rowCount: 14, filters: { budgetId: "b-gone", eventCode: "HM2026", versionNo: 3 } } }),
      auditRow({ id: "a4", entityType: "Supplier", entityId: "org:org1", action: "IMPORT", changes: { format: "csv", totalProcessed: 5, created: 3, updated: 0, skipped: 2, errors: 0 } }),
    ]);
    const res = await GET(req("?scope=procurement"));
    const body = (await res.json()) as Array<{ id: string; subjectName: string | null; title: string; detail: string | null }>;
    expect(body.map((r) => [r.id, r.subjectName, r.title, r.detail])).toEqual([
      ["a1", "PR-2026-0009", "Request cancelled", "reason: Vendor withdrew"],
      ["a2", "PO-2026-0002", "Order cancelled", "5,000.00 released, reason: Duplicate"],
      ["a3", "HM2026 v3", "Budget exported", "14 rows, CSV"],
      ["a4", null, "Suppliers imported", "3 created, 0 updated, 2 skipped, CSV"],
    ]);
    // The export's org-scoped entityId never reaches a budget lookup; the
    // import's never reaches a supplier lookup; nothing else is on the page.
    expect(mockDb.supplier.findMany).not.toHaveBeenCalled();
    expect(mockDb.budgetProduct.findMany).not.toHaveBeenCalled();
    expect(mockDb.budgetCategory.findMany).not.toHaveBeenCalled();
    expect(mockDb.budgetTemplate.findMany).not.toHaveBeenCalled();
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
    expect(mockDb.budgetLine.findMany).not.toHaveBeenCalled();
    const budgetArg = mockDb.eventBudget.findMany.mock.calls[0][0] as { where: { id: { in: string[] } } };
    expect(budgetArg.where.id.in).toEqual(["b-gone"]);
  });
});
