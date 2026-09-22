/**
 * The registration gate for the procurement tools: nothing registers while
 * the flag is off or for an API key, a reading role gets the reads, the
 * writes register only on the in-app door for an authoring role, and every
 * tool answers through the service (mocked here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const svc = vi.hoisted(() => ({ listBudgets: vi.fn(), getBudget: vi.fn(), createBudget: vi.fn(), upsertBudgetLine: vi.fn(), deleteBudgetLine: vi.fn() }));
vi.mock("@/procurement/services/budget-service", () => svc);
const catSvc = vi.hoisted(() => ({ ensureBudgetCategories: vi.fn() }));
vi.mock("@/procurement/services/budget-category-service", () => catSvc);
const tplSvc = vi.hoisted(() => ({ ensureBudgetTemplates: vi.fn() }));
vi.mock("@/procurement/services/budget-template-service", () => tplSvc);
const revSvc = vi.hoisted(() => ({ getBudgetRevenue: vi.fn() }));
vi.mock("@/procurement/services/budget-revenue-service", () => revSvc);
const finance = vi.hoisted(() => ({ sees: true }));
vi.mock("@/lib/finance-visibility", () => ({ canViewFinance: () => finance.sees }));
const reqSvc = vi.hoisted(() => ({ listSpendRequests: vi.fn(), invalidSpendRequestStatusFilter: (s: string | undefined) => s !== undefined && !["DRAFT", "PENDING_APPROVAL", "APPROVED", "AWAITING_SUPPLIER", "CONVERTED", "REJECTED", "CANCELLED", "CLOSED", "SUBMITTED", "BUDGET_CHECKED"].includes(s) }));
vi.mock("@/procurement/services/spend-request-service", () => reqSvc);
const orderSvc = vi.hoisted(() => ({ listCommitments: vi.fn(), invalidCommitmentStatusFilter: (s: string | undefined) => s !== undefined && !["APPROVED", "SENT_TO_ACCOUNTING", "POSTED", "CLOSED", "CANCELLED"].includes(s) }));
vi.mock("@/procurement/services/commitment-service", () => orderSvc);
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));

import { registerProcurementMcpTools } from "@/procurement/agent-tools";

type Handler = (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: true }>;
function fakeServer() {
  const tools = new Map<string, Handler>();
  return { tools, server: { tool: (name: string, _d: string, _p: unknown, h: Handler) => { tools.set(name, h); } } as never };
}
const budget = { id: "b1", eventCode: "TW2SE26", versionNo: 1, status: "ACTIVE", reportingCurrency: "AED", plannedExpenseTotal: "36725.0000", contingencyPercent: "10", contingencyAmount: "3672.5000", taxTotalPlanned: "1836.2500", forecastTotal: "36725.0000", atRisk: false, expectedAttendance: 120, recordedAttendance: null, plannedRevenueTotal: "50000.0000", targetMarginPercent: "30", lines: [] };
const revenue = {
  reportingCurrency: "AED", targetMarginPercent: "30",
  lines: [{ lineKey: "r1", category: { code: "430005", name: "In-House Delegate Sales" }, description: "Delegates", planned: "50000.0000", transactionCurrency: "USD", fxRateToReporting: "3.6725" }],
  accounts: [{ code: "430005", name: "In-House Delegate Sales", planned: "50000.0000", actual: "12000.0000" }],
  actuals: { notItemised: "500.0000", noAccount: { amount: "700.0000", products: [{ productName: "Online Advertising" }] }, notConverted: [{ from: "deals", currency: "GBP", amount: "900.0000" }], total: "13200.0000", paidRegistrations: 24, wonDeals: 2 },
  margin: { plannedRevenue: "50000.0000", plannedCost: "40397.5000", plannedMargin: "9602.5000", plannedMarginPercent: "19.21", forecastRevenue: "51200.0000", forecastCost: "40397.5000", forecastMargin: "10802.5000", forecastMarginPercent: "21.10", belowTarget: true },
};

const CATEGORIES = [
  { id: "c-venue", code: "510400", name: "Venue", type: "EXPENSE", parentId: null, depth: 0, sortOrder: 0, isActive: true },
  { id: "c-fb", code: "500700", name: "F&B", type: "EXPENSE", parentId: null, depth: 0, sortOrder: 1, isActive: true },
  { id: "c-old", code: "509999", name: "Retired", type: "EXPENSE", parentId: null, depth: 0, sortOrder: 2, isActive: false },
  { id: "c-cont", code: "CONTINGENCY", name: "Contingency", type: "EXPENSE", parentId: null, depth: 0, sortOrder: 3, isActive: true },
];
const IN_APP = { actorUserId: "u-author", source: "agent" as const };
const READS = ["get_budget", "list_budget_categories", "list_budget_templates", "list_budgets", "list_commitments", "list_spend_requests"];
const WRITES = ["add_budget_lines", "create_budget", "replace_budget_lines"];

beforeEach(() => {
  vi.clearAllMocks();
  finance.sees = true;
  process.env.PROCUREMENT_MODULE_ENABLED = "true";
  revSvc.getBudgetRevenue.mockResolvedValue({ ok: true, value: revenue });
  catSvc.ensureBudgetCategories.mockResolvedValue(CATEGORIES);
  tplSvc.ensureBudgetTemplates.mockResolvedValue([{ id: "t1", name: "Conference", eventType: "CONFERENCE", description: null, isActive: true, lines: [{ id: "l1" }, { id: "l2" }] }, { id: "t2", name: "Old", eventType: "WEBINAR", description: null, isActive: false, lines: [] }]);
  svc.upsertBudgetLine.mockResolvedValue({ ok: true, budget });
  svc.deleteBudgetLine.mockResolvedValue({ ok: true, budget });
});
afterEach(() => { delete process.env.PROCUREMENT_MODULE_ENABLED; });

describe("registration gate", () => {
  it("registers nothing while the module is off, even for an admin", () => {
    delete process.env.PROCUREMENT_MODULE_ENABLED;
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "SUPER_ADMIN", fromApiKey: false });
    expect(tools.size).toBe(0);
  });
  it("refuses an API key", () => {
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: null, fromApiKey: true });
    expect(tools.size).toBe(0);
  });
  it("refuses a role that cannot read procurement", () => {
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "WEBINARS", fromApiKey: false });
    expect(tools.size).toBe(0);
  });
  it("registers the six reads for a reading role on the MCP door, and no write", () => {
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "ORGANIZER", fromApiKey: false });
    expect([...tools.keys()].sort()).toEqual(READS);
  });
  it("registers the writes only on the in-app door, for a role that may author budgets", () => {
    const a = fakeServer();
    registerProcurementMcpTools(a.server, "org-1", { role: "ORGANIZER", fromApiKey: false }, IN_APP);
    expect([...a.tools.keys()].sort()).toEqual([...READS, ...WRITES].sort());
    // MEMBER reads the module but does not author budgets.
    const m = fakeServer();
    registerProcurementMcpTools(m.server, "org-1", { role: "MEMBER", fromApiKey: false }, IN_APP);
    expect([...m.tools.keys()].sort()).toEqual(READS);
    // The MCP door carries a placeholder id, not a person: reads only even for an admin.
    const d = fakeServer();
    registerProcurementMcpTools(d.server, "org-1", { role: "ADMIN", fromApiKey: false }, { actorUserId: "mcp-system", source: "mcp" });
    expect([...d.tools.keys()].sort()).toEqual(READS);
    // No user id at all: reads only.
    const n = fakeServer();
    registerProcurementMcpTools(n.server, "org-1", { role: "ADMIN", fromApiKey: false }, { source: "agent" });
    expect([...n.tools.keys()].sort()).toEqual(READS);
  });
});

describe("the setup reads", () => {
  it("list_budget_categories names active expense codes and leaves contingency and retired ones out", async () => {
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "MEMBER", fromApiKey: false });
    const text = (await tools.get("list_budget_categories")!({})).content[0].text;
    expect(text).toContain("- 510400: Venue");
    expect(text).toContain("- 500700: F&B");
    expect(text).not.toContain("509999");
    expect(text).not.toContain("- CONTINGENCY");
    expect(catSvc.ensureBudgetCategories).toHaveBeenCalledWith("org-1");
  });
  it("list_budget_templates lists the active templates with their ids and line counts", async () => {
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "MEMBER", fromApiKey: false });
    const text = (await tools.get("list_budget_templates")!({})).content[0].text;
    expect(text).toContain("- Conference (CONFERENCE), 2 line(s)\n  ID: t1");
    expect(text).not.toContain("Old");
  });
});

describe("the writes (in-app door)", () => {
  function authoring() {
    const f = fakeServer();
    registerProcurementMcpTools(f.server, "org-1", { role: "ORGANIZER", fromApiKey: false }, IN_APP);
    return f;
  }

  it("create_budget delegates with the signed-in person and the agent source, and reports the draft", async () => {
    svc.createBudget.mockResolvedValue({ ok: true, budget: { ...budget, status: "DRAFT", lines: [{ isContingency: true }, { isContingency: false }, { isContingency: false }] } });
    const { tools } = authoring();
    const out = await tools.get("create_budget")!({ eventId: "ev1", reportingCurrency: "USD", templateId: "t1", contingencyPercent: 5 });
    expect(svc.createBudget).toHaveBeenCalledWith({
      organizationId: "org-1", actorUserId: "u-author", source: "agent",
      eventId: "ev1", templateId: "t1", reportingCurrency: "USD", contingencyPercent: 5, expectedAttendance: null, brand: null, notes: null,
    });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("Created a draft budget:");
    expect(out.content[0].text).toContain("ID: b1");
    expect(out.content[0].text).toContain("2 line(s) seeded from the template");
  });

  it("create_budget surfaces the service's refusal with its code", async () => {
    svc.createBudget.mockResolvedValue({ ok: false, code: "BUDGET_EXISTS", message: "This event already has a budget." });
    const { tools } = authoring();
    const out = await tools.get("create_budget")!({ eventId: "ev1", reportingCurrency: "AED" });
    expect(out.content[0].text).toBe("Error: This event already has a budget. (BUDGET_EXISTS)");
  });

  it("add_budget_lines resolves codes to ids, writes each line through the service and reports the refused one", async () => {
    svc.upsertBudgetLine
      .mockResolvedValueOnce({ ok: true, budget })
      .mockResolvedValueOnce({ ok: false, code: "RATE_REQUIRED", message: "A EUR line needs its exchange rate to AED." });
    const { tools } = authoring();
    const out = await tools.get("add_budget_lines")!({
      budgetId: "b1",
      lines: [
        { categoryCode: "510400", description: "Hall hire", unitCost: 20000, qty: 2, taxRatePercent: 5 },
        { categoryCode: "500700", description: "Gala dinner", unitCost: 300, currency: "EUR" },
      ],
    });
    expect(svc.upsertBudgetLine).toHaveBeenCalledTimes(2);
    expect(svc.upsertBudgetLine.mock.calls[0][0]).toEqual({
      organizationId: "org-1", actorUserId: "u-author", source: "agent", budgetId: "b1",
      categoryId: "c-venue", description: "Hall hire", qty: 2, unitCost: 20000, transactionCurrency: undefined, fxRateToReporting: null, taxRatePercent: 5, notes: null,
    });
    expect(svc.upsertBudgetLine.mock.calls[1][0]).toMatchObject({ categoryId: "c-fb", transactionCurrency: "EUR", qty: 1, taxRatePercent: null });
    expect(out.content[0].text).toContain("Added 1 of 2 line(s).");
    expect(out.content[0].text).toContain('line 2 "Gala dinner": A EUR line needs its exchange rate to AED. (RATE_REQUIRED)');
    expect(out.content[0].text).toContain("Budget now: TW2SE26 v1");
  });

  it("add_budget_lines writes nothing when any category code is unknown, and names the valid ones", async () => {
    const { tools } = authoring();
    const out = await tools.get("add_budget_lines")!({ budgetId: "b1", lines: [{ categoryCode: "510400", description: "ok", unitCost: 1 }, { categoryCode: "999999", description: "typo", unitCost: 1 }] });
    expect(svc.upsertBudgetLine).not.toHaveBeenCalled();
    expect(out.content[0].text).toContain("unknown category code(s) 999999; nothing was written");
    expect(out.content[0].text).toContain("510400 (Venue)");
  });

  it("replace_budget_lines refuses without confirm and touches nothing", async () => {
    const { tools } = authoring();
    const out = await tools.get("replace_budget_lines")!({ budgetId: "b1", lines: [{ categoryCode: "510400", description: "x", unitCost: 1 }] });
    expect(JSON.parse(out.content[0].text).code).toBe("APPROVAL_REQUIRED");
    expect(svc.getBudget).not.toHaveBeenCalled();
    expect(svc.deleteBudgetLine).not.toHaveBeenCalled();
    expect(svc.upsertBudgetLine).not.toHaveBeenCalled();
  });

  it("replace_budget_lines, confirmed, removes every non-contingency line of a draft and then adds the new ones", async () => {
    svc.getBudget.mockResolvedValue({ ok: true, budget: { ...budget, status: "DRAFT", lines: [
      { id: "L-cont", lineKey: "k0", description: "Contingency", isContingency: true },
      { id: "L-1", lineKey: "k1", description: "Old hall", isContingency: false },
      { id: "L-2", lineKey: "k2", description: "Old dinner", isContingency: false },
    ] } });
    const { tools } = authoring();
    const out = await tools.get("replace_budget_lines")!({ budgetId: "b1", confirm: true, lines: [{ categoryCode: "500700", description: "New dinner", unitCost: 500 }] });
    expect(svc.deleteBudgetLine.mock.calls.map((c) => c[0].lineId)).toEqual(["L-1", "L-2"]);
    expect(svc.deleteBudgetLine.mock.calls[0][0]).toMatchObject({ organizationId: "org-1", actorUserId: "u-author", source: "agent", budgetId: "b1" });
    expect(svc.upsertBudgetLine).toHaveBeenCalledTimes(1);
    expect(svc.upsertBudgetLine.mock.calls[0][0]).toMatchObject({ categoryId: "c-fb", description: "New dinner", unitCost: 500 });
    expect(out.content[0].text).toContain("Removed 2 line(s). Added 1 of 1 line(s).");
  });

  it("replace_budget_lines refuses a budget that is not a draft, and a bad code before removing anything", async () => {
    svc.getBudget.mockResolvedValueOnce({ ok: true, budget: { ...budget, status: "ACTIVE", lines: [{ id: "L-1", lineKey: "k1", description: "x", isContingency: false }] } });
    const { tools } = authoring();
    const active = await tools.get("replace_budget_lines")!({ budgetId: "b1", confirm: true, lines: [{ categoryCode: "510400", description: "x", unitCost: 1 }] });
    expect(active.content[0].text).toContain("draft version only; this budget is ACTIVE (INVALID_STATUS)");
    expect(svc.deleteBudgetLine).not.toHaveBeenCalled();

    svc.getBudget.mockResolvedValueOnce({ ok: true, budget: { ...budget, status: "DRAFT", lines: [{ id: "L-1", lineKey: "k1", description: "x", isContingency: false }] } });
    const typo = await tools.get("replace_budget_lines")!({ budgetId: "b1", confirm: true, lines: [{ categoryCode: "000000", description: "x", unitCost: 1 }] });
    expect(typo.content[0].text).toContain("unknown category code(s) 000000; nothing was written");
    expect(svc.deleteBudgetLine).not.toHaveBeenCalled();
    expect(svc.upsertBudgetLine).not.toHaveBeenCalled();
  });

  it("replace_budget_lines stops at a line it cannot remove and adds nothing", async () => {
    svc.getBudget.mockResolvedValue({ ok: true, budget: { ...budget, status: "DRAFT", lines: [
      { id: "L-1", lineKey: "k1", description: "Removable", isContingency: false },
      { id: "L-2", lineKey: "k2", description: "Committed AV", isContingency: false },
    ] } });
    svc.deleteBudgetLine.mockResolvedValueOnce({ ok: true, budget }).mockResolvedValueOnce({ ok: false, code: "LINE_HAS_COMMITMENTS", message: "This line has open commitments." });
    const { tools } = authoring();
    const out = await tools.get("replace_budget_lines")!({ budgetId: "b1", confirm: true, lines: [{ categoryCode: "510400", description: "x", unitCost: 1 }] });
    expect(out.content[0].text).toContain('could not remove "Committed AV": This line has open commitments. (LINE_HAS_COMMITMENTS). 1 of 2 line(s) had already been removed; no new lines were added.');
    expect(svc.upsertBudgetLine).not.toHaveBeenCalled();
  });
});

describe("the tools", () => {
  it("list_budgets passes the org from the grant and the filters from the input", async () => {
    svc.listBudgets.mockResolvedValue([budget]);
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "MEMBER", fromApiKey: false });
    const out = await tools.get("list_budgets")!({ eventId: "ev1", status: "ACTIVE" });
    expect(svc.listBudgets).toHaveBeenCalledWith("org-1", { eventId: "ev1", status: "ACTIVE" });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("TW2SE26 v1 [ACTIVE] planned AED 36725.0000");
    expect(out.content[0].text).toContain("ID: b1");
  });
  it("get_budget renders the lines and reports a miss without throwing", async () => {
    svc.getBudget.mockResolvedValueOnce({ ok: true, budget: { ...budget, lines: [{ lineKey: "k1", description: "Hall hire", isContingency: false, planned: "36725.0000", transactionCurrency: "USD", fxRateToReporting: "3.6725", committedTotal: "0.0000", actual: "0.0000", paid: "0.0000", remaining: "36725.0000", forecast: "36725.0000", forecastFinalAmount: null, forecastReason: null, varianceNote: null }] } });
    svc.getBudget.mockResolvedValueOnce({ ok: false, code: "BUDGET_NOT_FOUND", message: "The budget was not found." });
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "ADMIN", fromApiKey: false });
    const hit = await tools.get("get_budget")!({ budgetId: "b1" });
    expect(hit.content[0].text).toContain("Hall hire: planned 36725.0000 (USD at 3.6725)");
    expect(hit.content[0].text).toContain("lineKey: k1");
    const miss = await tools.get("get_budget")!({ budgetId: "nope" });
    expect(miss.content[0].text).toContain("Error: The budget was not found.");
    expect(svc.getBudget).toHaveBeenLastCalledWith("org-1", "nope");
  });
});

describe("revenue and margin on the budget reads", () => {
  it("list_budgets shows planned revenue and the target", async () => {
    svc.listBudgets.mockResolvedValue([budget]);
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "ADMIN", fromApiKey: false });
    const out = await tools.get("list_budgets")!({});
    expect(out.content[0].text).toContain("planned revenue 50000.0000, target margin 30%");
  });
  it("get_budget adds the accounts, what sits outside them and the margin against the target", async () => {
    svc.getBudget.mockResolvedValue({ ok: true, budget });
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "ORGANIZER", fromApiKey: false });
    const text = (await tools.get("get_budget")!({ budgetId: "b1" })).content[0].text;
    expect(revSvc.getBudgetRevenue).toHaveBeenCalledWith("org-1", "b1");
    expect(text).toContain("Revenue and margin (AED, ex-VAT), actuals from 24 paid registration(s) and 2 won deal(s):");
    expect(text).toContain("430005 In-House Delegate Sales: planned 50000.0000, actual 12000.0000");
    expect(text).toContain("not itemised on won deals: 500.0000");
    expect(text).toContain("products with no income account: 700.0000 (Online Advertising)");
    expect(text).toContain("not counted, no fixed rate to AED: deals GBP 900.0000");
    expect(text).toContain("forecast: revenue 51200.0000, cost 40397.5000, margin 10802.5000 (21.10%)");
    expect(text).toContain("target margin 30%: forecast BELOW target");
    expect(text).toContain("planned line: 430005 Delegates: 50000.0000 (USD at 3.6725)");
  });
  it("get_budget still answers with the expense side when the revenue read fails", async () => {
    svc.getBudget.mockResolvedValue({ ok: true, budget });
    revSvc.getBudgetRevenue.mockResolvedValue({ ok: false, code: "UNKNOWN", message: "Could not load." });
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "ADMIN", fromApiKey: false });
    const out = await tools.get("get_budget")!({ budgetId: "b1" });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("TW2SE26 v1 [ACTIVE]");
    expect(out.content[0].text).toContain("Revenue and margin: could not be read (Could not load.).");
  });
  it("shows no revenue to a role without finance sight, and never reads it", async () => {
    finance.sees = false;
    svc.getBudget.mockResolvedValue({ ok: true, budget });
    svc.listBudgets.mockResolvedValue([budget]);
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "MEMBER", fromApiKey: false });
    const got = (await tools.get("get_budget")!({ budgetId: "b1" })).content[0].text;
    const listed = (await tools.get("list_budgets")!({})).content[0].text;
    expect(revSvc.getBudgetRevenue).not.toHaveBeenCalled();
    expect(got).toContain("Revenue and margin: not shown, they need finance access.");
    expect(got).not.toContain("50000");
    expect(listed).not.toContain("planned revenue");
  });
});

describe("the purchasing reads (slice 3)", () => {
  it("list_spend_requests names the status, the figures, the requester and the order once issued", async () => {
    reqSvc.listSpendRequests.mockResolvedValue([{ id: "sr1", requestNo: "PR-2026-0007", statusLabel: "Ordered", title: "LED wall", currency: "EUR", amount: "1000.0000", taxAmount: "50.0000", eventCode: "HM2026", budget: { versionNo: 1 }, budgetCheckStatus: "WITHIN_BUDGET", requesterName: "Dev Admin", supplier: { displayName: "Gulf AV" }, proposedVendorName: null, lineKey: "k-av", order: { commitmentNo: "PO-2026-0003", fulfillmentLabel: "Not received" } }]);
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "MEMBER", fromApiKey: false });
    const out = await tools.get("list_spend_requests")!({ status: "CONVERTED" });
    expect(reqSvc.listSpendRequests).toHaveBeenCalledWith("org-1", { status: "CONVERTED", budgetId: undefined });
    expect(out.content[0].text).toContain("PR-2026-0007 [Ordered] LED wall: EUR 1000.0000 ex-VAT (VAT 50.0000), event HM2026 v1");
    expect(out.content[0].text).toContain("order PO-2026-0003 (Not received)");
    expect(out.content[0].text).toContain("ID: sr1  lineKey: k-av");
    const bad = await tools.get("list_spend_requests")!({ status: "NOPE" });
    expect(bad.content[0].text).toContain("Error: unknown status filter");
    expect(reqSvc.listSpendRequests).toHaveBeenCalledTimes(1);
  });
  it("list_commitments names the supplier, the receiving state and the second-person wait", async () => {
    orderSvc.listCommitments.mockResolvedValue([{ id: "c1", commitmentNo: "PO-2026-0003", statusLabel: "Issued", supplier: { displayName: "Gulf AV" }, currency: "EUR", amount: "1000.0000", taxAmount: "50.0000", eventCode: "HM2026", fulfillmentLabel: "Received", fulfillmentStatus: "RECEIVED", receiptNeedsSecondPerson: true, receiptConfirmed: false, sentToSupplierAt: "2026-09-15T08:00:00Z", spendRequest: { requestNo: "PR-2026-0007" }, requesterName: "Dev Admin", lineKey: "k-av" }]);
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "ADMIN", fromApiKey: false });
    const out = await tools.get("list_commitments")!({ supplierId: "s1" });
    expect(orderSvc.listCommitments).toHaveBeenCalledWith("org-1", { status: undefined, budgetId: undefined, supplierId: "s1" });
    expect(out.content[0].text).toContain("PO-2026-0003 [Issued] Gulf AV: EUR 1000.0000 ex-VAT (VAT 50.0000), event HM2026, Received, receipt awaiting a second person, sent to supplier, from PR-2026-0007 raised by Dev Admin");
  });
});
