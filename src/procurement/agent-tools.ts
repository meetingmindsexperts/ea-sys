/**
 * Budget & Procurement tools for both agent doors. Lives INSIDE
 * src/procurement/ and is imported by exactly one core file,
 * src/lib/agent/register-mcp-tools.ts, a named touch point on the one-way
 * import boundary (the CRM precedent, src/crm/agent-tools.ts). Since the
 * Event Agent's Phase 1 the in-app door collects the same registrations, so
 * this file serves it too without a second touch point.
 *
 * Registration is the gate, so the tool list itself tells the truth:
 *  - nothing registers while PROCUREMENT_MODULE_ENABLED is off (a dark module
 *    shows no tools on production);
 *  - an API key is refused outright: procurement is a per-person surface and a
 *    key has nobody behind it, no role and no grant (the HR rule);
 *  - the six READS register when the actor's role may read the module
 *    (SUPER_ADMIN, ADMIN, ORGANIZER, MEMBER). A grant-only reader cannot be
 *    recognised here because the MCP context carries the role, not the id, and
 *    /mcp-authorize admits staff roles only, so nothing is lost;
 *  - the three WRITES (create_budget, add_budget_lines, replace_budget_lines;
 *    owner decision Sep 22, 2026: "create + set lines, submit stays off")
 *    register ONLY on the in-app door, where the acting person is the
 *    signed-in user, and only for a role that may author budgets. A budget
 *    has an owner and every line an actor, and the MCP door still carries a
 *    placeholder id rather than a person (the same reason create_spend_request
 *    is deferred there). Submitting for approval stays a page action.
 *    replace_budget_lines pauses for the person's approval (approvals.ts):
 *    it removes every existing line of a draft before adding the new ones.
 *
 * Revenue and margin (17 September 2026) ride on get_budget and list_budgets
 * only for a grant whose role has finance sight, the same boundary the budget
 * page's Revenue and margin section and the CSV export keep. Every reading role
 * registered here has it today; the check stays so a narrower reading role
 * added later does not inherit revenue by accident.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { isProcurementModuleEnabled } from "@/lib/module-flags";
import { canAuthorBudgets, canViewProcurement } from "@/lib/procurement-visibility";
import { canViewFinance } from "@/lib/finance-visibility";
import { APPROVAL_CONFIRM_PARAM, APPROVAL_REQUIRED_CODE } from "@/lib/agent/approvals";
import { createBudget, deleteBudgetLine, getBudget, listBudgets, upsertBudgetLine, type BudgetLineView, type BudgetView } from "@/procurement/services/budget-service";
import { ensureBudgetCategories } from "@/procurement/services/budget-category-service";
import { ensureBudgetTemplates } from "@/procurement/services/budget-template-service";
import { BUDGET_CURRENCIES, EVENT_BRANDS } from "@/procurement/lib/budget-schemas";
import { CONTINGENCY_CATEGORY_CODE } from "@/procurement/lib/budget-categories-seed";
import { getBudgetRevenue, type BudgetRevenueView } from "@/procurement/services/budget-revenue-service";
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

export interface ProcurementMcpOptions {
  /** The acting user's id: the signed-in person on the in-app door, a placeholder on the MCP door. */
  actorUserId?: string;
  /** Which door these registrations serve; the writes register for "agent" only. */
  source?: "mcp" | "agent";
}

const BUDGET_STATUSES = ["DRAFT", "UNDER_REVIEW", "APPROVED", "ACTIVE", "FROZEN", "CLOSED", "ARCHIVED"] as const;

/** One line as the agent hands it in; codes rather than ids, since the model reads list_budget_categories. */
const LINE_INPUT = z.object({
  categoryCode: z.string().trim().min(1).max(50).describe("A category code from list_budget_categories, e.g. 510400."),
  description: z.string().trim().min(1).max(500).describe("What the line is for."),
  unitCost: z.number().min(0).describe("Unit cost ex-VAT in the line's currency."),
  qty: z.number().positive().optional().describe("Quantity; default 1."),
  currency: z.enum(BUDGET_CURRENCIES).optional().describe("Defaults to the budget's reporting currency."),
  fxRateToReporting: z.number().positive().optional().describe("Needed when currency differs from the budget's: reporting-currency units per 1 unit of this currency."),
  taxRatePercent: z.number().min(0).max(100).optional().describe("VAT rate for the line; leave out for no VAT."),
  notes: z.string().max(5000).optional(),
});
type LineInput = z.infer<typeof LINE_INPUT>;
const LINES_PARAM = z.array(LINE_INPUT).min(1).max(100).describe("Up to 100 lines.");

function budgetLine(b: BudgetView, financeSight: boolean): string {
  return (
    `${b.eventCode ?? "(no event code)"} v${b.versionNo} [${b.status}] planned ${b.reportingCurrency} ${b.plannedExpenseTotal}` +
    ` (contingency ${b.contingencyPercent}% = ${b.contingencyAmount}, tax ${b.taxTotalPlanned}), forecast ${b.forecastTotal}` +
    (b.atRisk ? " AT RISK" : "") +
    (financeSight ? `, planned revenue ${b.plannedRevenueTotal}${b.targetMarginPercent !== null ? `, target margin ${b.targetMarginPercent}%` : ""}` : "") +
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

function pctText(v: string | null): string {
  return v === null ? "no percent, no revenue" : `${v}%`;
}

/** The Revenue and margin section as text, figures in the reporting currency ex-VAT. */
function revenueText(r: BudgetRevenueView): string {
  const a = r.actuals;
  const m = r.margin;
  const out = [`Revenue and margin (${r.reportingCurrency}, ex-VAT), actuals from ${a.paidRegistrations} paid registration(s) and ${a.wonDeals} won deal(s):`];
  if (r.accounts.length === 0) out.push("  no planned or actual revenue yet");
  for (const acc of r.accounts) out.push(`  ${acc.code} ${acc.name}: planned ${acc.planned}, actual ${acc.actual}`);
  out.push(`  not itemised on won deals: ${a.notItemised}`);
  out.push(`  products with no income account: ${a.noAccount.amount}${a.noAccount.products.length ? ` (${a.noAccount.products.map((p) => p.productName).join("; ")})` : ""}`);
  for (const n of a.notConverted) out.push(`  not counted, no fixed rate to ${r.reportingCurrency}: ${n.from} ${n.currency} ${n.amount}`);
  out.push(`  planned: revenue ${m.plannedRevenue}, cost with contingency ${m.plannedCost}, margin ${m.plannedMargin} (${pctText(m.plannedMarginPercent)})`);
  out.push(`  forecast: revenue ${m.forecastRevenue}, cost ${m.forecastCost}, margin ${m.forecastMargin} (${pctText(m.forecastMarginPercent)})`);
  out.push(r.targetMarginPercent === null ? "  no target margin set" : `  target margin ${r.targetMarginPercent}%: forecast ${m.belowTarget ? "BELOW target" : "meets target"}`);
  for (const l of r.lines) out.push(`  planned line: ${l.category.code} ${l.description}: ${l.planned}${l.transactionCurrency !== r.reportingCurrency ? ` (${l.transactionCurrency} at ${l.fxRateToReporting})` : ""}\n    lineKey: ${l.lineKey}`);
  return out.join("\n");
}

export function registerProcurementMcpTools(server: McpServer, organizationId: string, actor: ProcurementMcpActor, opts: ProcurementMcpOptions = {}): void {
  if (!isProcurementModuleEnabled()) return;
  if (actor.fromApiKey) {
    apiLogger.info({ msg: "mcp:procurement-tools-not-registered", reason: "api-key", organizationId });
    return;
  }
  if (!canViewProcurement({ role: actor.role })) {
    apiLogger.info({ msg: "mcp:procurement-tools-not-registered", reason: "role", role: actor.role, organizationId });
    return;
  }
  const financeSight = canViewFinance(actor.role);
  const source = opts.source ?? "mcp";
  const actorUserId = opts.actorUserId ?? null;
  // The writes need a person: the in-app door's signed-in user with a role
  // that may author budgets. Reads-only otherwise, logged so the absence is
  // explained rather than mysterious.
  const canWrite = source === "agent" && !!actorUserId && canAuthorBudgets({ role: actor.role });
  if (!canWrite) {
    apiLogger.info({
      msg: "mcp:procurement-writes-not-registered",
      reason: source !== "agent" ? "door" : !actorUserId ? "no-user" : "role",
      role: actor.role,
      source,
      organizationId,
    });
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
    "List event budgets (Budget & Procurement module): every version of every event's budget with status, planned expense total, contingency, forecast, planned revenue and target margin in the budget's reporting currency. Optional eventId narrows to one event; optional status narrows to DRAFT / UNDER_REVIEW / APPROVED / ACTIVE / FROZEN / CLOSED / ARCHIVED. Use the returned ID with get_budget.",
    {
      eventId: z.string().optional().describe("Narrow to one event's budget versions."),
      status: z.enum(BUDGET_STATUSES).optional().describe("Narrow to one lifecycle status."),
    },
    async (input) =>
      safeTool("list_budgets", async () => {
        const budgets = await listBudgets(organizationId, { eventId: input.eventId, status: input.status });
        if (budgets.length === 0) return "No budgets match.";
        return `${budgets.length} budget version(s):\n` + budgets.map((b) => budgetLine(b, financeSight)).join("\n");
      }),
  );

  server.tool(
    "get_budget",
    "Get one budget version with its lines (Budget & Procurement module): each line's planned, committed, actual, paid and remaining amounts, its forecast, and any close-out variance note; then revenue and margin: planned and actual revenue per income account (actuals read from paid registrations and won CRM deals, ex-VAT), the part of won deals not itemised by product, products with no income account, amounts not counted for having no fixed exchange rate, planned and forecast margin, and the target margin. Amounts are in the budget's reporting currency; a line in another currency shows its rate.",
    { budgetId: z.string().min(1).describe("The budget id from list_budgets.") },
    async (input) =>
      safeTool("get_budget", async () => {
        const [r, rev] = await Promise.all([getBudget(organizationId, input.budgetId), financeSight ? getBudgetRevenue(organizationId, input.budgetId) : null]);
        if (!r.ok) {
          apiLogger.warn({ msg: "mcp:get_budget-rejected", code: r.code, organizationId });
          return `Error: ${r.message}`;
        }
        const b = r.budget;
        const lines = b.lines ?? [];
        const expense = budgetLine(b, financeSight) + `\n${lines.length} line(s):\n` + lines.map(lineLine).join("\n");
        if (!rev) return `${expense}\nRevenue and margin: not shown, they need finance access.`;
        if (!rev.ok) {
          apiLogger.warn({ msg: "mcp:get_budget-revenue-rejected", code: rev.code, organizationId });
          return `${expense}\nRevenue and margin: could not be read (${rev.message}).`;
        }
        return `${expense}\n${revenueText(rev.value)}`;
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

  server.tool(
    "list_budget_categories",
    "List the budget categories (Budget & Procurement module): the organisation's chart-of-accounts cost groups, each as a code and a name. A budget line files under one of these; hand the CODE to add_budget_lines or replace_budget_lines. Contingency is not a line category: it is sized by the budget's contingency percent.",
    {},
    async () =>
      safeTool("list_budget_categories", async () => {
        const cats = await ensureBudgetCategories(organizationId);
        const usable = cats.filter((c) => c.isActive && c.type === "EXPENSE" && c.code !== CONTINGENCY_CATEGORY_CODE);
        if (usable.length === 0) return "No active expense categories.";
        return `${usable.length} expense categor${usable.length === 1 ? "y" : "ies"} (code: name):\n` + usable.map((c) => `- ${c.code}: ${c.name}`).join("\n") +
          "\nContingency is sized by the budget's contingency percent, not entered as a line.";
      }),
  );

  server.tool(
    "list_budget_templates",
    "List the budget templates (Budget & Procurement module): each active template's id, name, the event type it suits (CONFERENCE, WEBINAR, HYBRID) and how many lines it seeds. Hand the id to create_budget as templateId to start a draft with one blank line per category.",
    {},
    async () =>
      safeTool("list_budget_templates", async () => {
        const templates = (await ensureBudgetTemplates(organizationId)).filter((t) => t.isActive);
        if (templates.length === 0) return "No active budget templates.";
        return `${templates.length} template(s):\n` + templates.map((t) => `- ${t.name} (${t.eventType}), ${t.lines.length} line(s)\n  ID: ${t.id}`).join("\n");
      }),
  );

  if (!canWrite || !actorUserId) return;
  const writer = { organizationId, actorUserId, source };

  /** Category codes to ids, all-or-nothing: an unknown code writes nothing and names the valid ones. */
  async function resolveCategoryIds(codes: string[]): Promise<{ ok: true; byCode: Map<string, string> } | { ok: false; text: string }> {
    const cats = await ensureBudgetCategories(organizationId);
    const usable = cats.filter((c) => c.isActive && c.type === "EXPENSE" && c.code !== CONTINGENCY_CATEGORY_CODE);
    const byCode = new Map(usable.map((c) => [c.code, c.id]));
    const unknown = [...new Set(codes)].filter((c) => !byCode.has(c));
    if (unknown.length > 0) {
      return {
        ok: false,
        text: `Error: unknown category code(s) ${unknown.join(", ")}; nothing was written. Valid codes: ${usable.map((c) => `${c.code} (${c.name})`).join(", ")}.`,
      };
    }
    return { ok: true, byCode };
  }

  /** Adds the lines one by one through the service; a failing line is reported and the rest still land. */
  async function addLines(tool: string, budgetId: string, lines: LineInput[]): Promise<{ text: string; added: number }> {
    const resolved = await resolveCategoryIds(lines.map((l) => l.categoryCode));
    if (!resolved.ok) {
      apiLogger.warn({ msg: `mcp:${tool}-rejected`, code: "CATEGORY_NOT_FOUND", organizationId, budgetId, source });
      return { text: resolved.text, added: 0 };
    }
    const failures: string[] = [];
    let added = 0;
    let latest: BudgetView | null = null;
    for (const [i, l] of lines.entries()) {
      const r = await upsertBudgetLine({
        ...writer,
        budgetId,
        categoryId: resolved.byCode.get(l.categoryCode)!,
        description: l.description,
        qty: l.qty ?? 1,
        unitCost: l.unitCost,
        transactionCurrency: l.currency,
        fxRateToReporting: l.fxRateToReporting ?? null,
        taxRatePercent: l.taxRatePercent ?? null,
        notes: l.notes ?? null,
      });
      if (r.ok) {
        added += 1;
        latest = r.budget;
      } else {
        failures.push(`line ${i + 1} "${l.description}": ${r.message} (${r.code})`);
        apiLogger.warn({ msg: `mcp:${tool}-line-rejected`, code: r.code, organizationId, budgetId, line: i + 1, source });
      }
    }
    const summary = latest ? budgetLine(latest, financeSight) : "";
    const text =
      `Added ${added} of ${lines.length} line(s).` +
      (failures.length ? `\nNot added:\n- ${failures.join("\n- ")}` : "") +
      (summary ? `\nBudget now: ${summary}` : "");
    return { text, added };
  }

  server.tool(
    "create_budget",
    "Create the first DRAFT budget for an event (Budget & Procurement module). The event must carry a code (set in Event Settings); an event that already has a budget is refused with BUDGET_EXISTS (a new version is made on the budget page). Optional templateId (from list_budget_templates) seeds one blank line per category; add figures with add_budget_lines. Nothing is submitted for approval: that stays on the budget page. Draft budgets can be discarded there.",
    {
      eventId: z.string().min(1).describe("The event id (from list_events)."),
      reportingCurrency: z.enum(BUDGET_CURRENCIES).describe("The budget's reporting currency."),
      templateId: z.string().min(1).optional().describe("A template id from list_budget_templates."),
      contingencyPercent: z.number().min(0).max(100).optional().describe("Contingency as a percent of planned expense; default 10."),
      expectedAttendance: z.number().int().min(0).max(1_000_000).optional(),
      brand: z.enum(EVENT_BRANDS).optional(),
      notes: z.string().max(5000).optional(),
    },
    async (input) =>
      safeTool("create_budget", async () => {
        const r = await createBudget({
          ...writer,
          eventId: input.eventId,
          templateId: input.templateId ?? null,
          reportingCurrency: input.reportingCurrency,
          contingencyPercent: input.contingencyPercent,
          expectedAttendance: input.expectedAttendance ?? null,
          brand: input.brand ?? null,
          notes: input.notes ?? null,
        });
        if (!r.ok) {
          apiLogger.warn({ msg: "mcp:create_budget-rejected", code: r.code, organizationId, eventId: input.eventId, source });
          return `Error: ${r.message} (${r.code})`;
        }
        const seeded = (r.budget.lines ?? []).filter((l) => !l.isContingency).length;
        return `Created a draft budget:\n${budgetLine(r.budget, financeSight)}\n${seeded} line(s) seeded from the template. Add figures with add_budget_lines (use list_budget_categories for the codes). Submitting for approval is done on the budget page.`;
      }),
  );

  server.tool(
    "add_budget_lines",
    "Add lines to a DRAFT budget (Budget & Procurement module), up to 100 in one call, each with a category code from list_budget_categories, a description, a unit cost ex-VAT and an optional quantity, currency, exchange rate and VAT rate. Existing lines are kept. An unknown category code writes nothing; a line the service refuses is reported while the others still land. To start over, use replace_budget_lines.",
    { budgetId: z.string().min(1).describe("The budget id from list_budgets or create_budget."), lines: LINES_PARAM },
    async (input) => safeTool("add_budget_lines", async () => (await addLines("add_budget_lines", input.budgetId, input.lines)).text),
  );

  server.tool(
    "replace_budget_lines",
    "Replace every line of a DRAFT budget (Budget & Procurement module): removes all existing lines (the contingency line stays, it follows the percent), then adds the given ones, up to 100. Needs the person's approval before it runs. A line with open commitments cannot be removed; a budget that is not a draft is refused.",
    {
      budgetId: z.string().min(1).describe("The budget id from list_budgets or create_budget."),
      lines: LINES_PARAM,
      [APPROVAL_CONFIRM_PARAM]: z.boolean().optional().describe("This action needs the person's explicit approval. Tell them exactly what will happen, wait for their yes, then call again with confirm: true."),
    },
    async (input) =>
      safeTool("replace_budget_lines", async () => {
        if ((input as Record<string, unknown>)[APPROVAL_CONFIRM_PARAM] !== true) {
          apiLogger.info({ msg: "mcp:approval-required", tool: "replace_budget_lines", organizationId, budgetId: input.budgetId, source });
          return JSON.stringify({
            error: "replace_budget_lines needs the person's explicit approval. Tell them exactly what will happen (how many lines are removed and added), wait for their yes, then call it again with confirm: true.",
            code: APPROVAL_REQUIRED_CODE,
          });
        }
        const current = await getBudget(organizationId, input.budgetId);
        if (!current.ok) {
          apiLogger.warn({ msg: "mcp:replace_budget_lines-rejected", code: current.code, organizationId, budgetId: input.budgetId, source });
          return `Error: ${current.message} (${current.code})`;
        }
        if (current.budget.status !== "DRAFT") {
          apiLogger.warn({ msg: "mcp:replace_budget_lines-rejected", code: "INVALID_STATUS", organizationId, budgetId: input.budgetId, status: current.budget.status, source });
          return `Error: lines are replaced on a draft version only; this budget is ${current.budget.status} (INVALID_STATUS). Nothing was changed.`;
        }
        // The codes are checked BEFORE anything is removed, so a typo cannot
        // empty a draft and then fail to refill it.
        const resolved = await resolveCategoryIds(input.lines.map((l) => l.categoryCode));
        if (!resolved.ok) {
          apiLogger.warn({ msg: "mcp:replace_budget_lines-rejected", code: "CATEGORY_NOT_FOUND", organizationId, budgetId: input.budgetId, source });
          return resolved.text;
        }
        const existing = (current.budget.lines ?? []).filter((l) => !l.isContingency);
        let removed = 0;
        for (const l of existing) {
          const d = await deleteBudgetLine({ ...writer, budgetId: input.budgetId, lineId: l.id });
          if (!d.ok) {
            apiLogger.warn({ msg: "mcp:replace_budget_lines-line-rejected", code: d.code, organizationId, budgetId: input.budgetId, lineKey: l.lineKey, source });
            return `Error: could not remove "${l.description}": ${d.message} (${d.code}). ${removed} of ${existing.length} line(s) had already been removed; no new lines were added.`;
          }
          removed += 1;
        }
        const { text } = await addLines("replace_budget_lines", input.budgetId, input.lines);
        return `Removed ${removed} line(s). ${text}`;
      }),
  );
}

