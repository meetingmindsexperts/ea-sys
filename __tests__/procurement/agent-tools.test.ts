/**
 * The MCP registration gate for the procurement tools: nothing registers while
 * the flag is off or for an API key, only a reading role registers, and the
 * two tools answer through the service (mocked here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const svc = vi.hoisted(() => ({ listBudgets: vi.fn(), getBudget: vi.fn() }));
vi.mock("@/procurement/services/budget-service", () => svc);
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
  it("registers the two reads for a reading role", () => {
    const { tools, server } = fakeServer();
    registerProcurementMcpTools(server, "org-1", { role: "ORGANIZER", fromApiKey: false });
    expect([...tools.keys()].sort()).toEqual(["get_budget", "list_budgets"]);
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
