/**
 * The MCP registration gate for the procurement tools: nothing registers while
 * the flag is off or for an API key, only a reading role registers, and the
 * two tools answer through the service (mocked here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const svc = vi.hoisted(() => ({ listBudgets: vi.fn(), getBudget: vi.fn() }));
vi.mock("@/procurement/services/budget-service", () => svc);
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

beforeEach(() => { vi.clearAllMocks(); finance.sees = true; process.env.PROCUREMENT_MODULE_ENABLED = "true"; revSvc.getBudgetRevenue.mockResolvedValue({ ok: true, value: revenue }); });
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
  it("registers the four reads for a reading role", () => {
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "ORGANIZER", fromApiKey: false });
    expect([...tools.keys()].sort()).toEqual(["get_budget", "list_budgets", "list_commitments", "list_spend_requests"]);
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
