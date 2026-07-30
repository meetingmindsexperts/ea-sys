/**
 * CRM tools for the MCP server — the pipeline, automatable from n8n / claude.ai
 * / Claude Desktop like every other domain (CRM_STATUS §3 "CRM → MCP: NOT WIRED",
 * now wired).
 *
 * BOUNDARY: this file lives INSIDE src/crm/ and is imported by exactly one core
 * file — src/lib/agent/register-mcp-tools.ts, a named exemption in the ESLint
 * import-boundary rule. Core stays out of the CRM; the CRM hands core one
 * registration function.
 *
 * SECURITY MODEL: an MCP caller is an org API key / OAuth grant — admin-
 * equivalent by the house rule (every CRM predicate returns true for isApiKey),
 * so deal values are visible and writes are allowed. `organizationId` is
 * injected from the validated key, NEVER from tool input; every id that arrives
 * as input is bound to that org by the services (the same org-binding the REST
 * routes get). Writes carry source: "mcp" into the CrmActivity trail.
 */
import { z } from "zod";
import { CrmDealPipeline, CrmProductSource, CrmContactStatus, CrmLifecycleStage } from "@prisma/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { buildDealWhere } from "@/crm/lib/deal-filters";
import { defaultOpenStage } from "@/crm/lib/crm-types";
import { companyDealValueBreakdown, type RollupDeal } from "@/crm/lib/company-rollup";
import { ensurePipelineStages } from "@/crm/services/pipeline-service";
import { ensureDealTypes } from "@/crm/services/deal-type-service";
import { buildCrmReport } from "@/crm/services/report-service";
import {
  createDeal,
  updateDeal,
  moveDealStage,
  closeDeal,
} from "@/crm/services/deal-service";
import { findOrCreateCompany, updateCompany } from "@/crm/services/company-service";
import { findOrCreateCrmContact, updateCrmContact } from "@/crm/services/crm-contact-service";
import {
  ensureCrmProducts,
  listCrmProducts,
  createCrmProduct,
  updateCrmProduct,
  listDealProducts,
  addDealProduct,
  updateDealProduct,
} from "@/crm/services/crm-product-service";
import { createTask, completeTask } from "@/crm/services/task-service";
import { createNote } from "@/crm/services/note-service";

/** Format a money pair honestly — never print a number without its currency. */
function money(value: unknown, currency: string): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? `${currency} ${n.toLocaleString("en-US")}` : "—";
}

/** A bare number with thousands separators (currency printed once by the caller). */
function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Per-currency Open / Won / Lost / Total value line for an account's deals.
 * LOST is shown separately, never in Total (money that never came); values are
 * never summed across currencies. "no deal value" when nothing is valued.
 */
function valueBreakdownLine(deals: RollupDeal[]): string {
  const breakdown = companyDealValueBreakdown(deals);
  if (breakdown.length === 0) return "no deal value";
  return breakdown
    .map(
      (b) =>
        `${b.currency} — open ${fmtNum(b.open)} · won ${fmtNum(b.won)}` +
        (b.lost > 0 ? ` · lost ${fmtNum(b.lost)}` : "") +
        ` · total ${fmtNum(b.total)}`,
    )
    .join("; ");
}

/**
 * One honest "products total" for a deal's line items — currency-mix aware
 * (mirrors sumDealProducts): "mixed currencies" rather than a fabricated sum.
 */
function productsTotalLine(
  lines: Array<{ unitPrice: unknown; currency: string; quantity: number }>,
): string {
  if (lines.length === 0) return "—";
  const currencies = new Set(lines.map((l) => l.currency));
  if (currencies.size > 1) return "mixed currencies";
  const currency = [...currencies][0] ?? "AED";
  const total = lines.reduce((acc, l) => acc + Number(l.unitPrice) * l.quantity, 0);
  return money(total, currency);
}

function fail(message: string): never {
  throw new Error(message);
}

/** Resolve an ownerEmail to an org team member's user id, or fail. */
async function resolveOwnerId(organizationId: string, ownerEmail: string): Promise<string> {
  const owner = await db.user.findFirst({
    where: { email: ownerEmail.toLowerCase(), organizationId },
    select: { id: true },
  });
  if (!owner) fail(`No org team member with email ${ownerEmail}`);
  return owner.id;
}

/** Derived project date/location from the linked event (city/country only). */
function projectDatesLine(event: { startDate: Date; endDate: Date } | null): string {
  if (!event?.startDate) return "";
  const start = event.startDate.toISOString().split("T")[0];
  const end = event.endDate ? event.endDate.toISOString().split("T")[0] : "";
  return end && end !== start ? `${start} – ${end}` : start;
}
function projectLocationLine(event: { city: string | null; country: string | null } | null): string {
  return [event?.city, event?.country].filter(Boolean).join(", ");
}

/**
 * Resolve a stage by id OR (case-insensitive) name, org-bound. Tool callers
 * usually know "Negotiation", not a cuid.
 */
async function resolveStageFlexible(organizationId: string, idOrName: string) {
  const stages = await ensurePipelineStages(organizationId);
  return (
    stages.find((s) => s.id === idOrName) ??
    stages.find((s) => s.name.trim().toLowerCase() === idOrName.trim().toLowerCase()) ??
    null
  );
}

/** Resolve a deal type by id OR (case-insensitive) name — active types only. */
async function resolveDealTypeFlexible(organizationId: string, idOrName: string) {
  const types = (await ensureDealTypes(organizationId)).filter((t) => !t.archivedAt);
  return (
    types.find((t) => t.id === idOrName) ??
    types.find((t) => t.name.trim().toLowerCase() === idOrName.trim().toLowerCase()) ??
    null
  );
}

export function registerCrmMcpTools(
  server: McpServer,
  organizationId: string,
  systemUserId: string,
): void {
  // Same error contract as the core registrations: a thrown error becomes an
  // MCP `isError` text response with the real message, logged server-side.
  async function safeTool(
    name: string,
    run: () => Promise<string>,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
    try {
      // Tenancy: every CRM MCP tool executes in the API key's org tenant store.
      // safeTool is the single choke point for all tools, so one wrap covers the
      // whole surface. No-op passthrough while RLS_SET_LOCAL is off (master).
      const text = await runWithTenant(organizationId, run);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      apiLogger.error({ msg: "MCP CRM tool failed", tool: name, organizationId, err: message });
      return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
  }

  // ── Pipeline ────────────────────────────────────────────────────────────────

  server.tool(
    "list_crm_pipeline",
    "List the CRM pipeline stages in board order, with each stage's deal count. Terminal stages carry a WON/LOST outcome — dragging/moving a deal into one closes it as that outcome.",
    {},
    async () =>
      safeTool("list_crm_pipeline", async () => {
        const stages = await ensurePipelineStages(organizationId);
        const counts = await db.crmDeal.groupBy({
          by: ["stageId"],
          where: { organizationId, archivedAt: null },
          _count: { _all: true },
        });
        const countByStage = new Map(counts.map((c) => [c.stageId, c._count._all]));
        return stages
          .map(
            (s) =>
              `${s.name} — ${countByStage.get(s.id) ?? 0} deal(s)` +
              (s.isTerminal ? ` [terminal${s.terminalOutcome ? `, closes as ${s.terminalOutcome}` : ""}]` : "") +
              `\n  ID: ${s.id}`,
          )
          .join("\n");
      }),
  );

  // ── Deals ───────────────────────────────────────────────────────────────────

  server.tool(
    "list_crm_deals",
    "List CRM sponsorship deals. Filters: eventId, status (OPEN/WON/LOST), pipeline (CORPORATE/CONFERENCE — the deal CATEGORY, distinct from the pipeline STAGES in list_crm_pipeline), dealType (the org-configurable business line — name or id, call list_crm_deal_types), stage (name or id), search (deal name contains), includeArchived, limit (default 50, max 200).",
    {
      eventId: z.string().optional(),
      status: z.enum(["OPEN", "WON", "LOST"]).optional(),
      pipeline: z.nativeEnum(CrmDealPipeline).optional().describe("Deal category: CORPORATE or CONFERENCE"),
      dealType: z.string().optional().describe("Deal type name or id (list_crm_deal_types)"),
      stage: z.string().optional().describe("Stage name or id"),
      search: z.string().optional(),
      includeArchived: z.boolean().optional(),
      limit: z.number().optional(),
    },
    async ({ eventId, status, pipeline, dealType, stage, search, includeArchived, limit }) =>
      safeTool("list_crm_deals", async () => {
        const where = buildDealWhere(
          {
            eventId: eventId ?? null,
            status: status ?? null,
            pipeline: pipeline ?? null,
            archived: includeArchived ? "1" : null,
          },
          { organizationId, canSeeValues: true }, // API key = admin-equivalent
        );
        if (stage) {
          const resolved = await resolveStageFlexible(organizationId, stage);
          if (!resolved) fail(`Unknown stage "${stage}" — call list_crm_pipeline for the stage list`);
          where.stageId = resolved.id;
        }
        if (dealType) {
          const dt = await resolveDealTypeFlexible(organizationId, dealType);
          if (!dt) fail(`Unknown deal type "${dealType}" — call list_crm_deal_types for the list`);
          where.dealTypeId = dt.id;
        }
        if (search) where.name = { contains: search, mode: "insensitive" };

        const deals = await db.crmDeal.findMany({
          where,
          select: {
            id: true, name: true, status: true, pipeline: true, tags: true, dealValue: true, currency: true,
            expectedClose: true, lostReason: true,
            dealType: { select: { name: true } },
            stage: { select: { name: true } },
            company: { select: { name: true } },
            // Project date + location are derived from the event (city/country only).
            event: { select: { name: true, startDate: true, endDate: true, city: true, country: true } },
            owner: { select: { firstName: true, lastName: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: Math.min(limit || 50, 200),
        });
        if (deals.length === 0) return "No deals match.";
        return deals
          .map(
            (d) =>
              `${d.name} — ${money(d.dealValue, d.currency)} — ${d.stage.name} (${d.status})` +
              `\n  ID: ${d.id}` +
              (d.pipeline ? `\n  Pipeline: ${d.pipeline}` : "") +
              (d.dealType ? `\n  Deal type: ${d.dealType.name}` : "") +
              (d.tags.length ? `\n  Tags: ${d.tags.join(", ")}` : "") +
              (d.company ? `\n  Account: ${d.company.name}` : "") +
              (d.event ? `\n  Event: ${d.event.name}` : "") +
              (projectDatesLine(d.event) ? `\n  Project dates: ${projectDatesLine(d.event)}` : "") +
              (projectLocationLine(d.event) ? `\n  Project location: ${projectLocationLine(d.event)}` : "") +
              (d.owner ? `\n  Owner: ${d.owner.firstName} ${d.owner.lastName}` : "") +
              (d.expectedClose ? `\n  Expected close: ${d.expectedClose.toISOString().split("T")[0]}` : "") +
              (d.status === "LOST" && d.lostReason ? `\n  Lost reason: ${d.lostReason}` : ""),
          )
          .join("\n\n");
      }),
  );

  server.tool(
    "list_crm_deal_types",
    "List the org's configurable deal TYPES (business lines like 'Sponsorship Inquiry', 'Industry Symposium') — the admin-editable dropdown shown on deals. Distinct from list_crm_pipeline (the board STAGES). Use a returned name or id as the `dealType` on create_crm_deal / update_crm_deal, or as the `dealType` filter on list_crm_deals.",
    {},
    async () =>
      safeTool("list_crm_deal_types", async () => {
        const types = (await ensureDealTypes(organizationId)).filter((t) => !t.archivedAt);
        if (types.length === 0) return "No deal types configured.";
        return types.map((t) => `${t.name}\n  ID: ${t.id}`).join("\n\n");
      }),
  );

  server.tool(
    "create_crm_deal",
    "Create a sponsorship deal. Required: name, eventId (the project the deal is sold against — a deal without an event is refused). Optional: companyName (the account — found or created, deduped on the normalized name), stage (name or id; defaults to the first open stage), pipeline (deal CATEGORY — CORPORATE or CONFERENCE; NOT a pipeline stage), dealType (the org-configurable business line — name or id, call list_crm_deal_types), tags (free-form labels, normalized), dealValue, currency (default USD), expectedClose (ISO date). Project date + location are derived from the event, not set here.",
    {
      name: z.string().min(1).max(255),
      eventId: z.string().min(1),
      companyName: z.string().optional(),
      stage: z.string().optional(),
      pipeline: z.nativeEnum(CrmDealPipeline).optional().describe("Deal category: CORPORATE or CONFERENCE"),
      dealType: z.string().optional().describe("Deal type name or id (list_crm_deal_types)"),
      tags: z.array(z.string().min(1).max(50)).max(25).optional(),
      dealValue: z.number().optional(),
      currency: z.string().length(3).optional(),
      expectedClose: z.string().optional().describe("ISO 8601 date"),
    },
    async (input) =>
      safeTool("create_crm_deal", async () => {
        const stages = await ensurePipelineStages(organizationId);
        // Shared default (R2-M10): the create dialog and this tool used to carry
        // identical inline copies of "first open column, else the first at all".
        const stageRow = input.stage
          ? await resolveStageFlexible(organizationId, input.stage)
          : defaultOpenStage(stages);
        if (!stageRow) fail(`Unknown stage "${input.stage}" — call list_crm_pipeline for the stage list`);

        let companyId: string | null = null;
        if (input.companyName?.trim()) {
          const company = await findOrCreateCompany({
            organizationId,
            userId: systemUserId,
            source: "mcp",
            name: input.companyName,
          });
          if (!company.ok) fail(company.message);
          companyId = company.company.id;
        }

        let dealTypeId: string | null = null;
        if (input.dealType?.trim()) {
          const dt = await resolveDealTypeFlexible(organizationId, input.dealType);
          if (!dt) fail(`Unknown deal type "${input.dealType}" — call list_crm_deal_types for the list`);
          dealTypeId = dt.id;
        }

        const res = await createDeal({
          organizationId,
          userId: systemUserId,
          source: "mcp",
          name: input.name,
          stageId: stageRow.id,
          companyId,
          eventId: input.eventId,
          pipeline: input.pipeline ?? null,
          dealTypeId,
          tags: input.tags,
          dealValue: input.dealValue ?? null,
          currency: input.currency,
          expectedClose: input.expectedClose ? new Date(input.expectedClose) : null,
        });
        if (!res.ok) fail(res.message);
        return `Deal created: ${res.deal.name}\n  ID: ${res.deal.id}\n  Stage: ${stageRow.name}` +
          (res.deal.pipeline ? `\n  Pipeline: ${res.deal.pipeline}` : "") +
          (res.deal.tags.length ? `\n  Tags: ${res.deal.tags.join(", ")}` : "") +
          `\n  Value: ${money(res.deal.dealValue, res.deal.currency)}`;
      }),
  );

  server.tool(
    "update_crm_deal",
    "Update a deal's fields: name, dealValue, currency, expectedClose (ISO date), eventId (re-point to another event; clearing is refused — a deal must stay on a project), pipeline (deal CATEGORY CORPORATE/CONFERENCE; pass null to clear), dealType (business line — name or id; pass null to clear), tags (REPLACES the whole tag list, normalized). Stage moves go through move_crm_deal_stage; closing through close_crm_deal.",
    {
      dealId: z.string().min(1),
      name: z.string().optional(),
      dealValue: z.number().nullable().optional(),
      currency: z.string().length(3).optional(),
      expectedClose: z.string().nullable().optional(),
      eventId: z.string().optional(),
      pipeline: z.nativeEnum(CrmDealPipeline).nullable().optional().describe("Deal category CORPORATE/CONFERENCE; null clears it"),
      dealType: z.string().nullable().optional().describe("Deal type name or id (list_crm_deal_types); null clears it"),
      tags: z.array(z.string().min(1).max(50)).max(25).optional().describe("Replaces the entire tag list"),
    },
    async (input) =>
      safeTool("update_crm_deal", async () => {
        // undefined = leave; null = clear; a name/id = resolve to the type's id.
        let dealTypeId: string | null | undefined = undefined;
        if (input.dealType === null) dealTypeId = null;
        else if (input.dealType?.trim()) {
          const dt = await resolveDealTypeFlexible(organizationId, input.dealType);
          if (!dt) fail(`Unknown deal type "${input.dealType}" — call list_crm_deal_types for the list`);
          dealTypeId = dt.id;
        }

        const res = await updateDeal({
          organizationId,
          userId: systemUserId,
          source: "mcp",
          dealId: input.dealId,
          dealTypeId,
          name: input.name,
          dealValue: input.dealValue,
          currency: input.currency,
          expectedClose:
            input.expectedClose === undefined
              ? undefined
              : input.expectedClose === null
                ? null
                : new Date(input.expectedClose),
          eventId: input.eventId,
          pipeline: input.pipeline,
          tags: input.tags,
        });
        if (!res.ok) fail(res.message);
        return `Deal updated: ${res.deal.name} (${res.deal.id})`;
      }),
  );

  server.tool(
    "move_crm_deal_stage",
    "Move a deal to another pipeline stage (by stage name or id). Moving into a terminal stage closes the deal as that stage's outcome; moving a closed deal out of a terminal stage REOPENS it. Race-safe: if someone moves the deal concurrently, this fails with the current stage.",
    {
      dealId: z.string().min(1),
      toStage: z.string().min(1).describe("Stage name or id"),
    },
    async ({ dealId, toStage }) =>
      safeTool("move_crm_deal_stage", async () => {
        const target = await resolveStageFlexible(organizationId, toStage);
        if (!target) fail(`Unknown stage "${toStage}" — call list_crm_pipeline for the stage list`);

        // The caller doesn't know the board's current state, so read the deal's
        // stage and use it as the claim's precondition — still race-safe: if the
        // board moves between this read and the write, the claim loses with 409
        // semantics instead of silently clobbering a human's drag.
        const current = await db.crmDeal.findFirst({
          where: { id: dealId, organizationId },
          select: { stageId: true },
        });
        if (!current) fail("Deal not found");

        const res = await moveDealStage({
          organizationId,
          userId: systemUserId,
          source: "mcp",
          dealId,
          fromStageId: current.stageId,
          toStageId: target.id,
        });
        if (!res.ok) fail(res.message);
        return `Deal moved to ${target.name}. Status: ${res.deal.status}`;
      }),
  );

  server.tool(
    "close_crm_deal",
    "Close a deal as WON or LOST. The deal lands in the matching terminal column. Refused when the pipeline has no column mapped to that outcome, when the deal is already closed, or when it is archived.",
    {
      dealId: z.string().min(1),
      outcome: z.enum(["WON", "LOST"]),
      lostReason: z.string().optional(),
    },
    async ({ dealId, outcome, lostReason }) =>
      safeTool("close_crm_deal", async () => {
        const res = await closeDeal({
          organizationId,
          userId: systemUserId,
          source: "mcp",
          dealId,
          outcome,
          lostReason: lostReason ?? null,
        });
        if (!res.ok) fail(res.message);
        return `Deal closed ${outcome}: ${res.deal.name} — ${money(res.deal.dealValue, res.deal.currency)}`;
      }),
  );

  // ── Companies ───────────────────────────────────────────────────────────────

  server.tool(
    "list_crm_companies",
    "List CRM accounts (companies) with per-account deal counts AND per-currency deal value: Open (pipeline) / Won / Lost / Total. LOST is shown separately and NEVER folded into Total (money that never came); value is never summed across currencies. Filters: search (name contains), includeArchived, limit (default 50, max 200).",
    {
      search: z.string().optional(),
      includeArchived: z.boolean().optional(),
      limit: z.number().optional(),
    },
    async ({ search, includeArchived, limit }) =>
      safeTool("list_crm_companies", async () => {
        const companies = await db.crmCompany.findMany({
          where: {
            organizationId,
            ...(includeArchived ? {} : { archivedAt: null }),
            ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
          },
          select: {
            id: true, name: true, industry: true, country: true, needsReview: true,
            _count: { select: { deals: true, contacts: true } },
            // Non-archived deals only for the value rollup (matches the account page).
            deals: {
              where: { archivedAt: null },
              select: { status: true, dealValue: true, currency: true },
            },
          },
          orderBy: { name: "asc" },
          take: Math.min(limit || 50, 200),
        });
        if (companies.length === 0) return "No companies match.";
        return companies
          .map(
            (c) =>
              `${c.name}${c.industry ? ` (${c.industry})` : ""}${c.needsReview ? " ⚠ needs duplicate review" : ""}` +
              `\n  ID: ${c.id} | Deals: ${c._count.deals} | Contacts: ${c._count.contacts}` +
              `\n  Value: ${valueBreakdownLine(c.deals)}`,
          )
          .join("\n\n");
      }),
  );

  server.tool(
    "create_crm_company",
    "Create a CRM account (company) — or link to the existing one if the name already exists (deduped on the normalized name; a near-duplicate is created but flagged for human review).",
    { name: z.string().min(1).max(255) },
    async ({ name }) =>
      safeTool("create_crm_company", async () => {
        const res = await findOrCreateCompany({
          organizationId,
          userId: systemUserId,
          source: "mcp",
          name,
        });
        if (!res.ok) fail(res.message);
        return res.created
          ? `Company created: ${res.company.name} (${res.company.id})${res.needsReview ? " — flagged as a possible duplicate for review" : ""}`
          : `Linked to the existing company: ${res.company.name} (${res.company.id})`;
      }),
  );

  // ── Tasks ───────────────────────────────────────────────────────────────────

  server.tool(
    "list_crm_tasks",
    "List CRM follow-up tasks. Filters: status (OPEN/DONE, default OPEN), overdueOnly, limit (default 50, max 200).",
    {
      status: z.enum(["OPEN", "DONE"]).optional(),
      overdueOnly: z.boolean().optional(),
      limit: z.number().optional(),
    },
    async ({ status, overdueOnly, limit }) =>
      safeTool("list_crm_tasks", async () => {
        const tasks = await db.crmTask.findMany({
          where: {
            organizationId,
            archivedAt: null,
            status: status ?? "OPEN",
            ...(overdueOnly ? { dueAt: { lt: new Date() } } : {}),
          },
          select: {
            id: true, title: true, status: true, dueAt: true,
            owner: { select: { firstName: true, lastName: true } },
            deal: { select: { id: true, name: true } },
            company: { select: { name: true } },
          },
          orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
          take: Math.min(limit || 50, 200),
        });
        if (tasks.length === 0) return "No tasks match.";
        return tasks
          .map(
            (t) =>
              `${t.title} (${t.status})` +
              `\n  ID: ${t.id}` +
              (t.dueAt ? `\n  Due: ${t.dueAt.toISOString().split("T")[0]}` : "") +
              (t.owner ? `\n  Owner: ${t.owner.firstName} ${t.owner.lastName}` : "\n  Owner: unassigned") +
              (t.deal ? `\n  Deal: ${t.deal.name} (${t.deal.id})` : t.company ? `\n  Account: ${t.company.name}` : ""),
          )
          .join("\n\n");
      }),
  );

  server.tool(
    "create_crm_task",
    "Create a CRM follow-up task. Optional: description, dueAt (ISO date — also arms the email reminder at that date), ownerEmail (must be an org team member; unassigned when omitted), dealId, companyId, crmContactId.",
    {
      title: z.string().min(1).max(255),
      description: z.string().optional(),
      dueAt: z.string().optional().describe("ISO 8601 date"),
      ownerEmail: z.string().email().optional(),
      dealId: z.string().optional(),
      companyId: z.string().optional(),
      crmContactId: z.string().optional(),
    },
    async (input) =>
      safeTool("create_crm_task", async () => {
        let ownerId: string | null = null;
        if (input.ownerEmail) {
          const owner = await db.user.findFirst({
            where: { email: input.ownerEmail.toLowerCase(), organizationId },
            select: { id: true },
          });
          if (!owner) fail(`No org team member with email ${input.ownerEmail}`);
          ownerId = owner.id;
        }
        const due = input.dueAt ? new Date(input.dueAt) : null;
        const res = await createTask({
          organizationId,
          userId: systemUserId,
          source: "mcp",
          title: input.title,
          description: input.description ?? null,
          dueAt: due,
          remindAt: due, // same contract as the UI: a due date arms the reminder
          ownerId,
          dealId: input.dealId ?? null,
          companyId: input.companyId ?? null,
          crmContactId: input.crmContactId ?? null,
        });
        if (!res.ok) fail(res.message);
        return `Task created: ${res.task.title} (${res.task.id})${due ? ` — due ${due.toISOString().split("T")[0]}, reminder armed` : ""}`;
      }),
  );

  server.tool(
    "complete_crm_task",
    "Mark a CRM task done. Refused when it is already done or archived.",
    { taskId: z.string().min(1) },
    async ({ taskId }) =>
      safeTool("complete_crm_task", async () => {
        const res = await completeTask({ organizationId, userId: systemUserId, source: "mcp", taskId });
        if (!res.ok) fail(res.message);
        return `Task completed: ${res.task.title}`;
      }),
  );

  // ── Notes ───────────────────────────────────────────────────────────────────

  server.tool(
    "add_crm_note",
    "Log a note / call / meeting on a CRM record. Attach to exactly one of dealId, companyId, crmContactId.",
    {
      body: z.string().min(1).max(10000),
      activityType: z.enum(["NOTE", "CALL", "MEETING"]).optional(),
      dealId: z.string().optional(),
      companyId: z.string().optional(),
      crmContactId: z.string().optional(),
    },
    async (input) =>
      safeTool("add_crm_note", async () => {
        const attachments = [input.dealId, input.companyId, input.crmContactId].filter(Boolean);
        if (attachments.length !== 1) fail("Attach the note to exactly one of dealId, companyId or crmContactId");
        const res = await createNote({
          organizationId,
          userId: systemUserId,
          source: "mcp",
          body: input.body,
          activityType: input.activityType,
          dealId: input.dealId ?? null,
          companyId: input.companyId ?? null,
          crmContactId: input.crmContactId ?? null,
        });
        if (!res.ok) fail(res.message);
        return `Note logged (${res.note.id})`;
      }),
  );

  // ── Report ──────────────────────────────────────────────────────────────────

  server.tool(
    "get_crm_report",
    "Pipeline report: per-stage deal counts + values, open-pipeline rollup, won/lost totals with win rate, and a per-rep leaderboard. Optional eventId filter. Money is currency-aware — a bucket mixing currencies reports 'mixed' rather than a fake sum.",
    { eventId: z.string().optional() },
    async ({ eventId }) =>
      safeTool("get_crm_report", async () => {
        // ONE report implementation (R2-M9): this tool used to compose its own
        // thinner groupBy shaping, which had already drifted from the REST
        // report (no open rollup, no win rate, no leaderboard). Both callers
        // now consume report-service. MCP callers are admin-equivalent, so
        // values are visible.
        await ensurePipelineStages(organizationId);
        const { pipeline, winLoss, reps } = await buildCrmReport({
          organizationId,
          canSeeValues: true,
          filters: { eventId: eventId ?? null },
        });

        const bucket = (b: { count: number; value: number | null; currency: string | null; mixed: boolean }) =>
          `${b.count} deal(s) — ${b.mixed ? "mixed currencies" : b.currency ? money(b.value, b.currency) : "no value"}`;

        const stageLines = pipeline.stages.map((s) => `  ${s.stageName}: ${bucket(s)}`);
        const openLine = pipeline.openMixed
          ? "mixed currencies"
          : pipeline.openCurrency
            ? money(pipeline.openValue, pipeline.openCurrency)
            : "no value";
        const wl = `  WON: ${bucket({ count: winLoss.wonCount, value: winLoss.wonValue, currency: winLoss.wonCurrency ?? null, mixed: winLoss.wonMixed ?? false })}\n  LOST: ${bucket({ count: winLoss.lostCount, value: winLoss.lostValue, currency: winLoss.lostCurrency ?? null, mixed: winLoss.lostMixed ?? false })}\n  Win rate: ${winLoss.winRate === null ? "— (nothing closed yet)" : `${winLoss.winRate}%`}`;
        const repLines = reps
          .slice(0, 5)
          .map(
            (r) =>
              `  ${r.ownerName}: ${r.wonCount} won${r.wonCurrency && !r.wonMixed ? ` (${money(r.wonValue, r.wonCurrency)})` : ""}, ${r.openCount} open`,
          );

        return (
          `Pipeline${eventId ? " (filtered to one event)" : ""}:\n${stageLines.join("\n")}\n` +
          `Open pipeline: ${pipeline.openCount} deal(s) — ${openLine}\n\n` +
          `Closed:\n${wl}` +
          (repLines.length > 0 ? `\n\nTop reps:\n${repLines.join("\n")}` : "")
        );
      }),
  );

  // ── Contacts ──────────────────────────────────────────────────────────────────

  server.tool(
    "list_crm_contacts",
    "List CRM business contacts (the people at accounts). Filters: search (name or email contains), companyId (contacts at one account), includeArchived, limit (default 50, max 200).",
    {
      search: z.string().optional(),
      companyId: z.string().optional(),
      includeArchived: z.boolean().optional(),
      limit: z.number().optional(),
    },
    async ({ search, companyId, includeArchived, limit }) =>
      safeTool("list_crm_contacts", async () => {
        const contacts = await db.crmContact.findMany({
          where: {
            organizationId,
            ...(includeArchived ? {} : { archivedAt: null }),
            ...(companyId ? { companyId } : {}),
            ...(search
              ? {
                  OR: [
                    { firstName: { contains: search, mode: "insensitive" } },
                    { lastName: { contains: search, mode: "insensitive" } },
                    { email: { contains: search, mode: "insensitive" } },
                  ],
                }
              : {}),
          },
          select: {
            id: true, firstName: true, lastName: true, email: true, jobTitle: true,
            phone: true, mobile: true, country: true, status: true, lifecycleStage: true,
            company: { select: { name: true } },
            _count: { select: { deals: true } },
          },
          orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
          take: Math.min(limit || 50, 200),
        });
        if (contacts.length === 0) return "No contacts match.";
        return contacts
          .map(
            (c) =>
              `${c.firstName} ${c.lastName}${c.jobTitle ? ` — ${c.jobTitle}` : ""}` +
              `\n  ID: ${c.id} | ${c.email}` +
              (c.company ? `\n  Account: ${c.company.name}` : "") +
              (c.phone || c.mobile ? `\n  Phone: ${[c.phone, c.mobile].filter(Boolean).join(" / ")}` : "") +
              (c.country ? `\n  Country: ${c.country}` : "") +
              (c.status ? `\n  Status: ${c.status}` : "") +
              (c.lifecycleStage ? `\n  Lifecycle: ${c.lifecycleStage}` : "") +
              `\n  Deals: ${c._count.deals}`,
          )
          .join("\n\n");
      }),
  );

  server.tool(
    "create_crm_contact",
    "Create a CRM business contact — or link to the existing one if the email already exists (deduped on the normalized email). Required: firstName, lastName, email. Optional: companyId (the account), jobTitle, phone, mobile, country, notes, ownerEmail (an org team member), status (NEW/CONTACTED/INTERESTED/QUALIFIED/NEGOTIATION/WON/LOST/UNQUALIFIED), lifecycleStage (LEAD/ENGAGED/CUSTOMER/CHAMPION), tags.",
    {
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      email: z.string().email(),
      companyId: z.string().optional(),
      jobTitle: z.string().optional(),
      phone: z.string().optional(),
      mobile: z.string().optional(),
      country: z.string().optional(),
      notes: z.string().optional(),
      ownerEmail: z.string().email().optional(),
      status: z.nativeEnum(CrmContactStatus).optional(),
      lifecycleStage: z.nativeEnum(CrmLifecycleStage).optional(),
      tags: z.array(z.string().min(1).max(50)).max(25).optional(),
    },
    async (input) =>
      safeTool("create_crm_contact", async () => {
        const ownerId = input.ownerEmail ? await resolveOwnerId(organizationId, input.ownerEmail) : null;
        const res = await findOrCreateCrmContact({
          organizationId,
          userId: systemUserId,
          source: "mcp",
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          companyId: input.companyId ?? null,
          jobTitle: input.jobTitle ?? null,
          phone: input.phone ?? null,
          mobile: input.mobile ?? null,
          country: input.country ?? null,
          notes: input.notes ?? null,
          status: input.status ?? null,
          lifecycleStage: input.lifecycleStage ?? null,
          tags: input.tags,
          ownerId,
        });
        if (!res.ok) fail(res.message);
        return res.created
          ? `Contact created: ${res.crmContact.firstName} ${res.crmContact.lastName} (${res.crmContact.id})`
          : `Linked to the existing contact: ${res.crmContact.firstName} ${res.crmContact.lastName} (${res.crmContact.id})`;
      }),
  );

  server.tool(
    "update_crm_contact",
    "Update a CRM contact's fields: firstName, lastName, email (kept deduped), companyId (re-point to another account; null unlinks), jobTitle, phone, mobile, country, notes, ownerEmail (reassign; null unowns), status, lifecycleStage, tags (REPLACES the whole list). Only the fields you pass change.",
    {
      crmContactId: z.string().min(1),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().email().optional(),
      companyId: z.string().nullable().optional(),
      jobTitle: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      mobile: z.string().nullable().optional(),
      country: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      ownerEmail: z.string().email().nullable().optional(),
      status: z.nativeEnum(CrmContactStatus).nullable().optional(),
      lifecycleStage: z.nativeEnum(CrmLifecycleStage).nullable().optional(),
      tags: z.array(z.string().min(1).max(50)).max(25).optional(),
    },
    async (input) =>
      safeTool("update_crm_contact", async () => {
        let ownerId: string | null | undefined = undefined;
        if (input.ownerEmail === null) ownerId = null;
        else if (input.ownerEmail) ownerId = await resolveOwnerId(organizationId, input.ownerEmail);

        const res = await updateCrmContact({
          organizationId,
          userId: systemUserId,
          source: "mcp",
          crmContactId: input.crmContactId,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          companyId: input.companyId,
          jobTitle: input.jobTitle,
          phone: input.phone,
          mobile: input.mobile,
          country: input.country,
          notes: input.notes,
          status: input.status,
          lifecycleStage: input.lifecycleStage,
          tags: input.tags,
          ownerId,
        });
        if (!res.ok) fail(res.message);
        return `Contact updated: ${res.crmContact.firstName} ${res.crmContact.lastName} (${res.crmContact.id})`;
      }),
  );

  // ── Company detail + edit ─────────────────────────────────────────────────────

  server.tool(
    "get_crm_company",
    "Full detail for ONE CRM account: profile, per-currency Open/Won/Lost/Total deal value (LOST separate, never in Total), its deals, and its people. Pass the company id (from list_crm_companies).",
    { companyId: z.string().min(1) },
    async ({ companyId }) =>
      safeTool("get_crm_company", async () => {
        const company = await db.crmCompany.findFirst({
          where: { id: companyId, organizationId },
          select: {
            id: true, name: true, industry: true, website: true, phone: true,
            country: true, city: true, notes: true, needsReview: true, archivedAt: true,
            deals: {
              where: { archivedAt: null },
              select: {
                id: true, name: true, status: true, dealValue: true, currency: true,
                stage: { select: { name: true } },
              },
              orderBy: { updatedAt: "desc" },
            },
            contacts: {
              where: { archivedAt: null },
              select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true },
              orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
            },
          },
        });
        if (!company) fail("Account not found");
        const loc = [company.city, company.country].filter(Boolean).join(", ");
        const dealLines = company.deals.length
          ? company.deals
              .map((d) => `  - ${d.name} — ${money(d.dealValue, d.currency)} — ${d.stage.name} (${d.status})\n      ID: ${d.id}`)
              .join("\n")
          : "  (none)";
        const peopleLines = company.contacts.length
          ? company.contacts
              .map((p) => `  - ${p.firstName} ${p.lastName}${p.jobTitle ? ` (${p.jobTitle})` : ""} — ${p.email}\n      ID: ${p.id}`)
              .join("\n")
          : "  (none)";
        return (
          `${company.name}${company.archivedAt ? " [archived]" : ""}${company.needsReview ? " ⚠ needs duplicate review" : ""}` +
          `\n  ID: ${company.id}` +
          (company.industry ? `\n  Industry: ${company.industry}` : "") +
          (loc ? `\n  Location: ${loc}` : "") +
          (company.website ? `\n  Website: ${company.website}` : "") +
          (company.phone ? `\n  Phone: ${company.phone}` : "") +
          (company.notes ? `\n  Notes: ${company.notes}` : "") +
          `\n  Value: ${valueBreakdownLine(company.deals)}` +
          `\n\nDeals (${company.deals.length}):\n${dealLines}` +
          `\n\nPeople (${company.contacts.length}):\n${peopleLines}`
        );
      }),
  );

  server.tool(
    "update_crm_company",
    "Update a CRM account's fields: name, industry, website, phone, country, city, notes, tags (REPLACES the whole list), needsReview (set false once you've confirmed a flagged near-duplicate is distinct). Only the fields you pass change.",
    {
      companyId: z.string().min(1),
      name: z.string().optional(),
      industry: z.string().nullable().optional(),
      website: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      country: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      tags: z.array(z.string().min(1).max(50)).max(25).optional(),
      needsReview: z.boolean().optional(),
    },
    async (input) =>
      safeTool("update_crm_company", async () => {
        const res = await updateCompany({
          organizationId,
          userId: systemUserId,
          source: "mcp",
          companyId: input.companyId,
          name: input.name,
          industry: input.industry,
          website: input.website,
          phone: input.phone,
          country: input.country,
          city: input.city,
          notes: input.notes,
          tags: input.tags,
          needsReview: input.needsReview,
        });
        if (!res.ok) fail(res.message);
        return `Account updated: ${res.company.name} (${res.company.id})`;
      }),
  );

  // ── Deal detail ────────────────────────────────────────────────────────────────

  server.tool(
    "get_crm_deal",
    "Full detail for ONE deal: fields, its line-item products (with a currency-aware products total), the contacts on the deal (with roles), recent notes/activity, and open tasks. Pass the deal id (from list_crm_deals).",
    { dealId: z.string().min(1) },
    async ({ dealId }) =>
      safeTool("get_crm_deal", async () => {
        const deal = await db.crmDeal.findFirst({
          where: { id: dealId, organizationId },
          select: {
            id: true, name: true, status: true, pipeline: true, tags: true,
            dealValue: true, currency: true, expectedClose: true, lostReason: true, archivedAt: true,
            dealType: { select: { name: true } },
            stage: { select: { name: true } },
            company: { select: { id: true, name: true } },
            event: { select: { name: true, startDate: true, endDate: true, city: true, country: true } },
            owner: { select: { firstName: true, lastName: true } },
          },
        });
        if (!deal) fail("Deal not found");

        const [lines, contacts, notes, tasks] = await Promise.all([
          db.crmDealProduct.findMany({
            where: { dealId },
            select: { id: true, productName: true, category: true, sku: true, unitPrice: true, currency: true, quantity: true },
            orderBy: { createdAt: "asc" },
          }),
          db.crmDealContact.findMany({
            where: { dealId },
            select: { role: true, crmContact: { select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true } } },
            orderBy: { createdAt: "asc" },
          }),
          db.crmNote.findMany({
            where: { dealId, organizationId },
            select: { activityType: true, body: true, createdAt: true, author: { select: { firstName: true, lastName: true } } },
            orderBy: { createdAt: "desc" },
            take: 5,
          }),
          db.crmTask.findMany({
            where: { dealId, organizationId, archivedAt: null, status: "OPEN" },
            select: { id: true, title: true, dueAt: true },
            orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
          }),
        ]);

        const productLines = lines.length
          ? lines
              .map(
                (l) =>
                  `  - ${l.productName} — ${l.quantity} × ${money(l.unitPrice, l.currency)} = ${money(Number(l.unitPrice) * l.quantity, l.currency)}` +
                  `${l.category ? ` [${l.category}]` : ""}\n      Line ID: ${l.id}`,
              )
              .join("\n")
          : "  (none)";
        const contactLines = contacts.length
          ? contacts
              .map(
                (dc) =>
                  `  - ${dc.crmContact.firstName} ${dc.crmContact.lastName} (${dc.role})` +
                  `${dc.crmContact.jobTitle ? ` — ${dc.crmContact.jobTitle}` : ""} — ${dc.crmContact.email}\n      ID: ${dc.crmContact.id}`,
              )
              .join("\n")
          : "  (none)";
        const noteLines = notes.length
          ? notes
              .map(
                (n) =>
                  `  - [${n.activityType}] ${n.createdAt.toISOString().split("T")[0]}` +
                  `${n.author ? ` ${n.author.firstName} ${n.author.lastName}` : ""}: ` +
                  `${n.body.length > 200 ? n.body.slice(0, 200) + "…" : n.body}`,
              )
              .join("\n")
          : "  (none)";
        const taskLines = tasks.length
          ? tasks.map((t) => `  - ${t.title}${t.dueAt ? ` (due ${t.dueAt.toISOString().split("T")[0]})` : ""}\n      ID: ${t.id}`).join("\n")
          : "  (none)";

        return (
          `${deal.name}${deal.archivedAt ? " [archived]" : ""} — ${money(deal.dealValue, deal.currency)} — ${deal.stage.name} (${deal.status})` +
          `\n  ID: ${deal.id}` +
          (deal.pipeline ? `\n  Pipeline: ${deal.pipeline}` : "") +
          (deal.dealType ? `\n  Deal type: ${deal.dealType.name}` : "") +
          (deal.tags.length ? `\n  Tags: ${deal.tags.join(", ")}` : "") +
          (deal.company ? `\n  Account: ${deal.company.name} (${deal.company.id})` : "") +
          (deal.event ? `\n  Event: ${deal.event.name}` : "") +
          (projectDatesLine(deal.event) ? `\n  Project dates: ${projectDatesLine(deal.event)}` : "") +
          (projectLocationLine(deal.event) ? `\n  Project location: ${projectLocationLine(deal.event)}` : "") +
          (deal.owner ? `\n  Owner: ${deal.owner.firstName} ${deal.owner.lastName}` : "") +
          (deal.expectedClose ? `\n  Expected close: ${deal.expectedClose.toISOString().split("T")[0]}` : "") +
          (deal.status === "LOST" && deal.lostReason ? `\n  Lost reason: ${deal.lostReason}` : "") +
          `\n\nProducts (${lines.length}) — total ${productsTotalLine(lines)}:\n${productLines}` +
          `\n\nContacts (${contacts.length}):\n${contactLines}` +
          `\n\nRecent notes (${notes.length}):\n${noteLines}` +
          `\n\nOpen tasks (${tasks.length}):\n${taskLines}`
        );
      }),
  );

  // ── Products (catalog + deal line items) ────────────────────────────────────────

  server.tool(
    "list_crm_products",
    "List the org's product/service catalog (the sellable items put on deals as line items). Filters: search (name or SKU contains), category, includeArchived, limit (default 100, max 500).",
    {
      search: z.string().optional(),
      category: z.string().optional(),
      includeArchived: z.boolean().optional(),
      limit: z.number().optional(),
    },
    async ({ search, category, includeArchived, limit }) =>
      safeTool("list_crm_products", async () => {
        await ensureCrmProducts(organizationId); // seed the built-in catalog once, like the REST products page
        const products = await listCrmProducts(organizationId, { includeArchived, category, q: search });
        if (products.length === 0) return "No products match.";
        return products
          .slice(0, Math.min(limit || 100, 500))
          .map(
            (p) =>
              `${p.name} — ${money(p.price, p.currency)}${p.priceIncludesTax ? " (incl. tax)" : ""}` +
              `\n  ID: ${p.id} | Category: ${p.category}${p.sku ? ` | SKU: ${p.sku}` : ""} | ${p.source}` +
              (p.archivedAt ? " | ARCHIVED" : ""),
          )
          .join("\n\n");
      }),
  );

  server.tool(
    "create_crm_product",
    "Add a product/service to the org catalog. Required: name, category. Optional: sku, source (IN_HOUSE/OUTSOURCED, default IN_HOUSE), price (default 0), currency (default AED), priceIncludesTax.",
    {
      name: z.string().min(1).max(255),
      category: z.string().min(1).max(120),
      sku: z.string().max(120).optional(),
      source: z.nativeEnum(CrmProductSource).optional(),
      price: z.number().min(0).optional(),
      currency: z.string().length(3).optional(),
      priceIncludesTax: z.boolean().optional(),
    },
    async (input) =>
      safeTool("create_crm_product", async () => {
        const res = await createCrmProduct({
          organizationId,
          userId: systemUserId,
          name: input.name,
          category: input.category,
          sku: input.sku ?? null,
          source: input.source,
          price: input.price,
          currency: input.currency,
          priceIncludesTax: input.priceIncludesTax,
        });
        if (!res.ok) fail(res.message);
        return `Product created: ${res.product.name} — ${money(res.product.price, res.product.currency)} (${res.product.id})`;
      }),
  );

  server.tool(
    "update_crm_product",
    "Update a catalog product: name, category, sku, source (IN_HOUSE/OUTSOURCED), price, currency, priceIncludesTax. Only the fields you pass change. Editing a product does NOT rewrite line items already on deals — those are snapshots.",
    {
      productId: z.string().min(1),
      name: z.string().max(255).optional(),
      category: z.string().max(120).optional(),
      sku: z.string().max(120).nullable().optional(),
      source: z.nativeEnum(CrmProductSource).optional(),
      price: z.number().min(0).optional(),
      currency: z.string().length(3).optional(),
      priceIncludesTax: z.boolean().optional(),
    },
    async (input) =>
      safeTool("update_crm_product", async () => {
        const res = await updateCrmProduct({
          organizationId,
          userId: systemUserId,
          productId: input.productId,
          name: input.name,
          category: input.category,
          sku: input.sku,
          source: input.source,
          price: input.price,
          currency: input.currency,
          priceIncludesTax: input.priceIncludesTax,
        });
        if (!res.ok) fail(res.message);
        return `Product updated: ${res.product.name} (${res.product.id})`;
      }),
  );

  server.tool(
    "list_crm_deal_products",
    "List the line-item products on ONE deal, with a currency-aware products total. Pass the deal id.",
    { dealId: z.string().min(1) },
    async ({ dealId }) =>
      safeTool("list_crm_deal_products", async () => {
        const lines = await listDealProducts(dealId, organizationId);
        if (lines === null) fail("Deal not found");
        if (lines.length === 0) return "No products on this deal.";
        return (
          lines
            .map(
              (l) =>
                `${l.productName} — ${l.quantity} × ${money(l.unitPrice, l.currency)} = ${money(Number(l.unitPrice) * l.quantity, l.currency)}` +
                `${l.category ? ` [${l.category}]` : ""}\n  Line ID: ${l.id}${l.sku ? ` | SKU: ${l.sku}` : ""}`,
            )
            .join("\n\n") + `\n\nTotal: ${productsTotalLine(lines)}`
        );
      }),
  );

  server.tool(
    "add_deal_product",
    "Add a catalog product as a line item on a deal. Required: dealId, crmProductId (from list_crm_products). Optional: unitPrice (defaults to the catalog list price), quantity (default 1). Refused if the product is already on the deal (edit its quantity instead) or if the product/deal is archived.",
    {
      dealId: z.string().min(1),
      crmProductId: z.string().min(1),
      unitPrice: z.number().min(0).optional(),
      quantity: z.number().int().min(1).optional(),
    },
    async (input) =>
      safeTool("add_deal_product", async () => {
        const res = await addDealProduct({
          organizationId,
          userId: systemUserId,
          dealId: input.dealId,
          crmProductId: input.crmProductId,
          unitPrice: input.unitPrice,
          quantity: input.quantity,
        });
        if (!res.ok) fail(res.message);
        return `Added ${res.line.productName} — ${res.line.quantity} × ${money(res.line.unitPrice, res.line.currency)} (line ${res.line.id})`;
      }),
  );

  server.tool(
    "update_deal_product",
    "Update a deal line item's unitPrice and/or quantity. Required: dealId, lineId (from list_crm_deal_products / get_crm_deal).",
    {
      dealId: z.string().min(1),
      lineId: z.string().min(1),
      unitPrice: z.number().min(0).optional(),
      quantity: z.number().int().min(1).optional(),
    },
    async (input) =>
      safeTool("update_deal_product", async () => {
        const res = await updateDealProduct({
          organizationId,
          dealId: input.dealId,
          lineId: input.lineId,
          unitPrice: input.unitPrice,
          quantity: input.quantity,
        });
        if (!res.ok) fail(res.message);
        return `Line updated: ${res.line.productName} — ${res.line.quantity} × ${money(res.line.unitPrice, res.line.currency)}`;
      }),
  );
}
