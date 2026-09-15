/**
 * The MCP registration gate for the procurement tools: nothing registers while
 * the flag is off or for an API key, only a reading role registers, and the
 * two tools answer through the service (mocked here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const svc = vi.hoisted(() => ({ listBudgets: vi.fn(), getBudget: vi.fn() }));
vi.mock("@/procurement/services/budget-service", () => svc);
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
const budget = { id: "b1", eventCode: "TW2SE26", versionNo: 1, status: "ACTIVE", reportingCurrency: "AED", plannedExpenseTotal: "36725.0000", contingencyPercent: "10", contingencyAmount: "3672.5000", taxTotalPlanned: "1836.2500", forecastTotal: "36725.0000", atRisk: false, expectedAttendance: 120, recordedAttendance: null, lines: [] };

beforeEach(() => { vi.clearAllMocks(); process.env.PROCUREMENT_MODULE_ENABLED = "true"; });
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
