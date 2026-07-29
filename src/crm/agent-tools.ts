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
import { CrmDealPipeline } from "@prisma/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildDealWhere } from "@/crm/lib/deal-filters";
import { defaultOpenStage } from "@/crm/lib/crm-types";
import { ensurePipelineStages } from "@/crm/services/pipeline-service";
import { ensureDealTypes } from "@/crm/services/deal-type-service";
import { buildCrmReport } from "@/crm/services/report-service";
import {
  createDeal,
  updateDeal,
  moveDealStage,
  closeDeal,
} from "@/crm/services/deal-service";
import { findOrCreateCompany } from "@/crm/services/company-service";
import { createTask, completeTask } from "@/crm/services/task-service";
import { createNote } from "@/crm/services/note-service";

/** Format a money pair honestly — never print a number without its currency. */
function money(value: unknown, currency: string): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? `${currency} ${n.toLocaleString("en-US")}` : "—";
}

function fail(message: string): never {
  throw new Error(message);
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
      const text = await run();
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
    "List CRM accounts (companies). Filters: search (name contains), includeArchived, limit (default 50, max 200).",
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
          },
          orderBy: { name: "asc" },
          take: Math.min(limit || 50, 200),
        });
        if (companies.length === 0) return "No companies match.";
        return companies
          .map(
            (c) =>
              `${c.name}${c.industry ? ` (${c.industry})` : ""}${c.needsReview ? " ⚠ needs duplicate review" : ""}` +
              `\n  ID: ${c.id} | Deals: ${c._count.deals} | Contacts: ${c._count.contacts}`,
          )
          .join("\n");
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
}
