/**
 * Budget & Procurement tools for the MCP server (Phase 1: two reads,
 * list_budgets and get_budget). Lives INSIDE src/procurement/ and is imported
 * by exactly one core file, src/lib/agent/register-mcp-tools.ts, a named touch
 * point on the one-way import boundary (the CRM precedent, src/crm/agent-tools.ts).
 *
 * Registration is the gate, so the tool list itself tells the truth:
 *  - nothing registers while PROCUREMENT_MODULE_ENABLED is off (a dark module
 *    shows no tools on production);
 *  - an API key is refused outright: procurement is a per-person surface and a
 *    key has nobody behind it, no role and no grant (the HR rule);
 *  - an OAuth grant registers when the granting user's role may read the module
 *    (SUPER_ADMIN, ADMIN, ORGANIZER, MEMBER). A grant-only reader cannot be
 *    recognised here because the MCP context carries the role, not the id, and
 *    /mcp-authorize admits staff roles only, so nothing is lost.
 * The in-app event agent does not get these yet: that would make event-tools.ts
 * a third touch point on the boundary (build plan §5).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { isProcurementModuleEnabled } from "@/lib/module-flags";
import { canViewProcurement } from "@/lib/procurement-visibility";
import { getBudget, listBudgets, type BudgetLineView, type BudgetView } from "@/procurement/services/budget-service";
import { invalidSpendRequestStatusFilter, listSpendRequests } from "@/procurement/services/spend-request-service";
import { invalidCommitmentStatusFilter, listCommitments } from "@/procurement/services/commitment-service";
import { SPEND_REQUEST_STATUS_LABEL } from "@/procurement/lib/spend-request-rules";
import { COMMITMENT_STATUS_LABEL } from "@/procurement/lib/commitment-rules";

export interface ProcurementMcpActor {
  /** Session role behind an OAuth grant; null for an API key. */
  role: string | null;
  /** Procurement refuses API keys; kept on the shape for symmetry with the CRM. */
  fromApiKey: boolean;
}

const BUDGET_STATUSES = ["DRAFT", "UNDER_REVIEW", "APPROVED", "ACTIVE", "FROZEN", "CLOSED", "ARCHIVED"] as const;

function budgetLine(b: BudgetView): string {
  return (
    `${b.eventCode ?? "(no event code)"} v${b.versionNo} [${b.status}] planned ${b.reportingCurrency} ${b.plannedExpenseTotal}` +
    ` (contingency ${b.contingencyPercent}% = ${b.contingencyAmount}, tax ${b.taxTotalPlanned}), forecast ${b.forecastTotal}` +
    (b.atRisk ? " AT RISK" : "") +
    `\n  ID: ${b.id}  expectedAttendance: ${b.expectedAttendance ?? "not set"}` +
    (b.recordedAttendance !== null && b.recordedAttendance !== undefined ? `  recordedAttendance: ${b.recordedAttendance}` : "")
  );
}

function lineLine(l: BudgetLineView): string {
  const window = l.forecastFinalAmount ? ` forecast ${l.forecast} (override: ${l.forecastReason ?? "no reason"})` : ` forecast ${l.forecast}`;
  return (
    `- ${l.isContingency ? "[contingency] " : ""}${l.description}: planned ${l.planned}` +
    (l.transactionCurrency ? ` (${l.transactionCurrency} at ${l.fxRateToReporting})` : "") +
    `, committed ${l.committedTotal}, actual ${l.actual}, paid ${l.paid}, remaining ${l.remaining},${window}` +
    (l.varianceNote ? `\n    variance note: ${l.varianceNote}` : "") +
    `\n    lineKey: ${l.lineKey}`
  );
}

export function registerProcurementMcpTools(server: McpServer, organizationId: string, actor: ProcurementMcpActor): void {
  if (!isProcurementModuleEnabled()) return;
  if (actor.fromApiKey) {
    apiLogger.info({ msg: "mcp:procurement-tools-not-registered", reason: "api-key", organizationId });
    return;
  }
  if (!canViewProcurement({ role: actor.role })) {
    apiLogger.info({ msg: "mcp:procurement-tools-not-registered", reason: "role", role: actor.role, organizationId });
    return;
  }

  async function safeTool(name: string, run: () => Promise<string>): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
    try {
      const text = await runWithTenant(organizationId, run);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      apiLogger.error({ msg: "MCP procurement tool failed", tool: name, organizationId, err: message });
      return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
  }

  server.tool(
    "list_budgets",
    "List event budgets (Budget & Procurement module): every version of every event's budget with status, planned expense total, contingency and forecast in the budget's reporting currency. Optional eventId narrows to one event; optional status narrows to DRAFT / UNDER_REVIEW / APPROVED / ACTIVE / FROZEN / CLOSED / ARCHIVED. Use the returned ID with get_budget.",
    {
      eventId: z.string().optional().describe("Narrow to one event's budget versions."),
      status: z.enum(BUDGET_STATUSES).optional().describe("Narrow to one lifecycle status."),
    },
    async (input) =>
      safeTool("list_budgets", async () => {
        const budgets = await listBudgets(organizationId, { eventId: input.eventId, status: input.status });
        if (budgets.length === 0) return "No budgets match.";
        return `${budgets.length} budget version(s):\n` + budgets.map(budgetLine).join("\n");
      }),
  );

  server.tool(
    "get_budget",
    "Get one budget version with its lines (Budget & Procurement module): each line's planned, committed, actual, paid and remaining amounts, its forecast, and any close-out variance note. Amounts are in the budget's reporting currency; a line in another currency shows its rate.",
    { budgetId: z.string().min(1).describe("The budget id from list_budgets.") },
    async (input) =>
      safeTool("get_budget", async () => {
        const r = await getBudget(organizationId, input.budgetId);
        if (!r.ok) {
          apiLogger.warn({ msg: "mcp:get_budget-rejected", code: r.code, organizationId });
          return `Error: ${r.message}`;
        }
        const b = r.budget;
        const lines = b.lines ?? [];
        return budgetLine(b) + `\n${lines.length} line(s):\n` + lines.map(lineLine).join("\n");
      }),
  );

  // Reads only (slice 3): a spend request is raised by a person holding the
  // request grant, and the MCP context carries a role, not a person, so
  // create_spend_request waits until the grant can be resolved for a grant.
  server.tool(
    "list_spend_requests",
    "List spend requests (Budget & Procurement module): number, title, event code, budget line, amount ex-VAT with its currency, budget check outcome, status (Draft, Pending approval, Approved, Awaiting supplier, Ordered, Rejected, Cancelled), the requester, and the purchase order number once issued. Optional status narrows; optional budgetId narrows to one budget version.",
    {
      status: z.enum(Object.keys(SPEND_REQUEST_STATUS_LABEL) as [string, ...string[]]).optional().describe("Narrow to one status."),
      budgetId: z.string().optional().describe("Narrow to one budget version (from list_budgets)."),
    },
    async (input) =>
      safeTool("list_spend_requests", async () => {
        if (invalidSpendRequestStatusFilter(input.status)) return "Error: unknown status filter.";
        const rows = await listSpendRequests(organizationId, { status: input.status, budgetId: input.budgetId });
        if (rows.length === 0) return "No spend requests match.";
        return `${rows.length} spend request(s):\n` + rows.map((r) =>
          `${r.requestNo} [${r.statusLabel}] ${r.title}: ${r.currency} ${r.amount} ex-VAT (VAT ${r.taxAmount}), event ${r.eventCode}` +
          (r.budget ? ` v${r.budget.versionNo}` : "") +
          `, check ${r.budgetCheckStatus}, raised by ${r.requesterName ?? "unknown"}` +
          (r.supplier ? `, supplier ${r.supplier.displayName}` : r.proposedVendorName ? `, proposed vendor ${r.proposedVendorName}` : "") +
          (r.order ? `, order ${r.order.commitmentNo} (${r.order.fulfillmentLabel})` : "") +
          `\n  ID: ${r.id}  lineKey: ${r.lineKey ?? "none"}`,
        ).join("\n");
      }),
  );

  server.tool(
    "list_commitments",
    "List purchase orders (Budget & Procurement module): order number, supplier, event code, amount ex-VAT with VAT beside it, status (Issued, Cancelled), whether it was sent to the supplier, receiving state (not received, partly received, received, and whether a second person has confirmed), and the request it came from. Optional status narrows; optional budgetId or supplierId narrows further.",
    {
      status: z.enum(Object.keys(COMMITMENT_STATUS_LABEL) as [string, ...string[]]).optional().describe("Narrow to one status."),
      budgetId: z.string().optional().describe("Narrow to one budget version."),
      supplierId: z.string().optional().describe("Narrow to one supplier."),
    },
    async (input) =>
      safeTool("list_commitments", async () => {
        if (invalidCommitmentStatusFilter(input.status)) return "Error: unknown status filter.";
        const rows = await listCommitments(organizationId, { status: input.status, budgetId: input.budgetId, supplierId: input.supplierId });
        if (rows.length === 0) return "No purchase orders match.";
        return `${rows.length} purchase order(s):\n` + rows.map((c) =>
          `${c.commitmentNo} [${c.statusLabel}] ${c.supplier.displayName}: ${c.currency} ${c.amount} ex-VAT (VAT ${c.taxAmount}), event ${c.eventCode}` +
          `, ${c.fulfillmentLabel}${c.receiptNeedsSecondPerson && c.fulfillmentStatus === "RECEIVED" ? (c.receiptConfirmed ? ", receipt confirmed" : ", receipt awaiting a second person") : ""}` +
          `, ${c.sentToSupplierAt ? "sent to supplier" : "not sent to supplier"}` +
          (c.spendRequest ? `, from ${c.spendRequest.requestNo} raised by ${c.requesterName ?? "unknown"}` : "") +
          `\n  ID: ${c.id}  lineKey: ${c.lineKey}`,
        ).join("\n");
      }),
  );
}
