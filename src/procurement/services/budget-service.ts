/**
 * The budget lifecycle (spec §6a): create from a template, author lines,
 * submit with the completeness check, approve on the AED matrix, activate one
 * version, clone a new version with stable lineKeys, reallocate under the 10%
 * rule, freeze, close with variance notes, sign off, reopen.
 *
 * ONE implementation for REST, MCP and the pages (the no-cross-caller-
 * duplication rule). Errors as values (src/services/README.md); the route
 * owns auth, Zod, the tenant lane and the HTTP status. Every mutating write is
 * conditional on the version it read, so two tabs cannot both save, and every
 * transition writes an AuditLog row with `source`.
 */
import { db } from "@/lib/db";
import { tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { Prisma } from "@prisma/client";
import { createApprovalRequest, decideApprovalRequest, cancelPendingApprovals, type Db } from "@/lib/approvals/approvals-service";
import type { ProcurementUserLike } from "@/lib/procurement-visibility";
import { CONTINGENCY_CATEGORY_CODE } from "../lib/budget-categories-seed";
import { cloneLineForNewVersion, missingForSubmission, reallocationAuthority } from "../lib/budget-rules";
import {
  budgetTotals,
  contingencyAmount,
  forecastFor,
  lineTotals,
  money,
  remaining,
  storedString,
  toAed,
  FLOATING_TO_AED_BAND,
  resolveReportingToAedRate,
  VARIANCE_NOTE_FLOOR_AED,
  varianceRequiresNote,
  type MoneyInput,
  type RateResolution,
} from "../lib/money";
import { EXCLUDE_FACULTY_WHERE } from "@/lib/faculty-filter";
import { ensureBudgetCategories } from "./budget-category-service";
import { lockEventCommitted, syncBudgetCommitted } from "./committed-figures";

export type BudgetErrorCode =
  | "EVENT_NOT_FOUND"
  | "EVENT_CODE_REQUIRED"
  | "BUDGET_EXISTS"
  | "BUDGET_NOT_FOUND"
  | "TEMPLATE_NOT_FOUND"
  | "CATEGORY_NOT_FOUND"
  | "CATEGORY_MISMATCH"
  | "LINE_NOT_FOUND"
  | "PRODUCT_NOT_FOUND"
  | "INVALID_STATUS"
  | "STALE_WRITE"
  | "CURRENCY_LOCKED"
  | "RATE_REQUIRED"
  | "INVALID_AMOUNT"
  | "INCOMPLETE"
  | "NO_APPROVER"
  | "APPROVAL_FAILED"
  | "VERSION_IN_PROGRESS"
  | "CAP_EXCEEDED"
  | "INVALID_FILTER"
  | "LINE_HAS_COMMITMENTS"
  | "VARIANCE_NOTES_REQUIRED"
  | "UNKNOWN";

export type BudgetResult<T> =
  | { ok: true; budget: T }
  | { ok: false; code: BudgetErrorCode; message: string; meta?: Record<string, unknown> };

type Source = "ui" | "mcp";

export const BUDGET_LINE_SELECT = {
  id: true, lineKey: true, templateLineId: true, productId: true, categoryId: true, description: true, qty: true, unitCost: true,
  transactionCurrency: true, fxRateToReporting: true, fxRateSource: true, fxRateAsOf: true, planned: true,
  committedOpen: true, committedTotal: true, actual: true, paid: true, taxCode: true, taxRatePercent: true,
  taxAmountPlanned: true, approvedPlanned: true, reallocatedOut: true, forecastFinalAmount: true, forecastReason: true,
  serviceStart: true, serviceEnd: true, notes: true, isContingency: true, varianceNote: true, sortOrder: true,
  deletedAt: true, createdAt: true, updatedAt: true,
  category: { select: { id: true, code: true, name: true, depth: true } },
  product: { select: { id: true, sku: true, name: true } },
} as const;

export const BUDGET_SELECT = {
  id: true, organizationId: true, eventId: true, eventCode: true, versionNo: true, brand: true, reportingCurrency: true,
  contingencyPercent: true, contingencyAmount: true, plannedExpenseTotal: true, taxTotalPlanned: true, forecastTotal: true,
  expectedAttendance: true, recordedAttendance: true, benchmarkSourceType: true, benchmarkSourceId: true, ownerUserId: true,
  financeOwnerUserId: true, status: true, atRisk: true, naCategoryCodes: true, freezeAt: true, submittedAt: true,
  approvedAt: true, approvedByUserId: true, activatedAt: true, frozenAt: true, closedAt: true, closedByUserId: true,
  signedOffAt: true, signedOffByUserId: true, closeOutSummary: true, notes: true, createdByUserId: true, version: true,
  createdAt: true, updatedAt: true,
  event: { select: { id: true, name: true, slug: true, startDate: true, endDate: true, eventType: true } },
} as const;

type BudgetRow = Prisma.EventBudgetGetPayload<{ select: typeof BUDGET_SELECT }>;
type LineRow = Prisma.BudgetLineGetPayload<{ select: typeof BUDGET_LINE_SELECT }>;

const s4 = (v: MoneyInput | null | undefined) => (v === null || v === undefined ? null : storedString(v));

export function toLineView(l: LineRow) {
  return {
    ...l,
    qty: storedString(l.qty),
    unitCost: storedString(l.unitCost),
    fxRateToReporting: money(l.fxRateToReporting).toString(),
    planned: storedString(l.planned),
    committedOpen: storedString(l.committedOpen),
    committedTotal: storedString(l.committedTotal),
    actual: storedString(l.actual),
    paid: storedString(l.paid),
    taxRatePercent: l.taxRatePercent === null ? null : money(l.taxRatePercent).toString(),
    taxAmountPlanned: storedString(l.taxAmountPlanned),
    approvedPlanned: s4(l.approvedPlanned),
    reallocatedOut: storedString(l.reallocatedOut),
    forecastFinalAmount: s4(l.forecastFinalAmount),
    remaining: storedString(remaining(l)),
    forecast: storedString(forecastFor(l)),
  };
}
export type BudgetLineView = ReturnType<typeof toLineView>;

export function toBudgetView(b: BudgetRow, lines?: LineRow[]) {
  return {
    ...b,
    contingencyPercent: money(b.contingencyPercent).toString(),
    contingencyAmount: storedString(b.contingencyAmount),
    plannedExpenseTotal: storedString(b.plannedExpenseTotal),
    taxTotalPlanned: storedString(b.taxTotalPlanned),
    forecastTotal: storedString(b.forecastTotal),
    lines: lines ? lines.filter((l) => !l.deletedAt).map(toLineView) : undefined,
  };
}
export type BudgetView = ReturnType<typeof toBudgetView>;

function fail(code: BudgetErrorCode, message: string, ctx: Record<string, unknown> = {}, meta?: Record<string, unknown>): BudgetResult<never> {
  apiLogger.warn({ msg: "procurement/budget:rejected", code, ...ctx });
  return { ok: false, code, message, ...(meta ? { meta } : {}) };
}

async function audit(client: Db, data: { userId: string; organizationId: string; action: string; entityType: string; entityId: string; changes: Prisma.InputJsonValue }) {
  await client.auditLog.create({ data }).catch((err) => apiLogger.error({ msg: "procurement/budget:audit-failed", err, action: data.action }));
}

async function loadBudget(client: Db, organizationId: string, budgetId: string) {
  return client.eventBudget.findFirst({ where: { id: budgetId, organizationId }, select: BUDGET_SELECT });
}
async function loadLines(client: Db, budgetId: string, includeDeleted = false) {
  return client.budgetLine.findMany({
    where: { budgetId, ...(includeDeleted ? {} : { deletedAt: null }) },
    select: BUDGET_LINE_SELECT,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * Recompute the totals from the live lines and keep the contingency line's
 * planned amount equal to the percent (so the two cannot drift), then write
 * them onto the budget. Called inside the caller's transaction after every
 * line or header change.
 */
export async function recomputeBudgetTotals(tx: Db, budgetId: string): Promise<void> {
  const b = await tx.eventBudget.findUnique({ where: { id: budgetId }, select: { id: true, contingencyPercent: true } });
  if (!b) return;
  const lines = await loadLines(tx, budgetId);
  const t = budgetTotals(lines, b.contingencyPercent);
  const cont = lines.find((l) => l.isContingency);
  if (cont) {
    const plannedNow = storedString(t.contingencyAmount);
    if (plannedNow !== storedString(cont.planned)) {
      await tx.budgetLine.update({ where: { id: cont.id }, data: { planned: plannedNow, unitCost: plannedNow, qty: "1" } });
      // The contingency line's forecast follows its planned amount.
      const t2 = budgetTotals(lines.map((l) => (l.id === cont.id ? { ...l, planned: plannedNow } : l)), b.contingencyPercent);
      t.forecastTotal = t2.forecastTotal;
      t.atRisk = t2.atRisk;
    }
  }
  await tx.eventBudget.update({
    where: { id: budgetId },
    data: {
      plannedExpenseTotal: storedString(t.plannedExpenseTotal),
      taxTotalPlanned: storedString(t.taxTotalPlanned),
      contingencyAmount: storedString(t.contingencyAmount),
      forecastTotal: storedString(t.forecastTotal),
      atRisk: t.atRisk,
    },
  });
}

// ── read ─────────────────────────────────────────────────────────────────────

const BUDGET_STATUSES: ReadonlySet<string> = new Set(["DRAFT", "UNDER_REVIEW", "APPROVED", "ACTIVE", "FROZEN", "CLOSED", "ARCHIVED"]);
/** A status filter the enum does not know: refused, never silently widened (the INVALID_FILTER rule). */
export function invalidBudgetStatusFilter(status: string | undefined): boolean {
  return status !== undefined && !BUDGET_STATUSES.has(status);
}

export async function listBudgets(organizationId: string, filter: { eventId?: string; status?: string } = {}) {
  const rows = await db.eventBudget.findMany({
    where: {
      organizationId,
      ...(filter.eventId ? { eventId: filter.eventId } : {}),
      ...(filter.status ? { status: filter.status as BudgetRow["status"] } : {}),
    },
    select: BUDGET_SELECT,
    orderBy: [{ eventCode: "asc" }, { versionNo: "desc" }],
  });
  return rows.map((r) => toBudgetView(r));
}

export async function getBudget(organizationId: string, budgetId: string): Promise<BudgetResult<BudgetView>> {
  const b = await loadBudget(db, organizationId, budgetId);
  if (!b) return fail("BUDGET_NOT_FOUND", "The budget was not found.", { budgetId });
  const lines = await loadLines(db, budgetId);
  return { ok: true, budget: toBudgetView(b, lines) };
}

// ── create ───────────────────────────────────────────────────────────────────

export interface CreateBudgetInput {
  organizationId: string;
  actorUserId: string;
  source: Source;
  eventId: string;
  templateId?: string | null;
  reportingCurrency: string;
  contingencyPercent?: MoneyInput;
  brand?: "MMG_EXPERTS" | "MEDCOM" | "MEDULIVE" | null;
  expectedAttendance?: number | null;
  benchmarkSourceType?: "EA_SYS_BUDGET" | "ARCHIVE_SUMMARY" | "NONE";
  benchmarkSourceId?: string | null;
  financeOwnerUserId?: string | null;
  notes?: string | null;
}

export async function createBudget(input: CreateBudgetInput): Promise<BudgetResult<BudgetView>> {
  const ctx = { eventId: input.eventId, userId: input.actorUserId };
  const event = await db.event.findFirst({
    where: { id: input.eventId, organizationId: input.organizationId },
    select: { id: true, code: true, name: true, eventType: true },
  });
  if (!event) return fail("EVENT_NOT_FOUND", "The event was not found.", ctx);
  if (!event.code) {
    return fail("EVENT_CODE_REQUIRED", "This event has no code. Set one in Event Settings (it becomes the QuickBooks Class label) before creating a budget.", ctx);
  }
  const existing = await db.eventBudget.count({ where: { eventId: event.id } });
  if (existing > 0) return fail("BUDGET_EXISTS", "This event already has a budget. Create a new version from the active one instead.", ctx);
  const template = input.templateId
    ? await db.budgetTemplate.findFirst({
        where: { id: input.templateId, organizationId: input.organizationId, isActive: true },
        select: { id: true, lines: { select: { id: true, categoryId: true, description: true, defaultQty: true, defaultUnitCost: true, defaultCurrency: true, taxCode: true, sortOrder: true }, orderBy: { sortOrder: "asc" } } },
      })
    : null;
  if (input.templateId && !template) return fail("TEMPLATE_NOT_FOUND", "The template was not found or is inactive.", ctx);
  const categories = await ensureBudgetCategories(input.organizationId);
  const contingencyCat = categories.find((c) => c.code === CONTINGENCY_CATEGORY_CODE);
  if (!contingencyCat) return fail("CATEGORY_NOT_FOUND", "The contingency category is missing from the catalogue.", ctx);
  const contingencyPercent = money(input.contingencyPercent ?? 10);
  if (contingencyPercent.lt(0) || contingencyPercent.gt(100)) return fail("INVALID_AMOUNT", "Contingency percent must be between 0 and 100.", ctx);

  try {
    const created = await tenantTransaction(async (tx) => {
      const budget = await tx.eventBudget.create({
        data: {
          organizationId: input.organizationId,
          eventId: event.id,
          eventCode: event.code!,
          versionNo: 1,
          brand: input.brand ?? null,
          reportingCurrency: input.reportingCurrency,
          contingencyPercent: contingencyPercent.toString(),
          expectedAttendance: input.expectedAttendance ?? null,
          benchmarkSourceType: input.benchmarkSourceType ?? "NONE",
          benchmarkSourceId: input.benchmarkSourceId ?? null,
          ownerUserId: input.actorUserId,
          financeOwnerUserId: input.financeOwnerUserId ?? null,
          createdByUserId: input.actorUserId,
          notes: input.notes ?? null,
        },
        select: { id: true },
      });
      let sort = 0;
      const seeded = (template?.lines ?? []).map((tl) => {
        const usable = !tl.defaultCurrency || tl.defaultCurrency === input.reportingCurrency;
        const qty = usable && tl.defaultQty !== null ? money(tl.defaultQty) : money(usable ? 1 : 0);
        const unitCost = usable && tl.defaultUnitCost !== null ? money(tl.defaultUnitCost) : money(0);
        const t = lineTotals({ qty, unitCost, fxRateToReporting: 1, taxRatePercent: null });
        return {
          organizationId: input.organizationId,
          budgetId: budget.id,
          lineKey: globalThis.crypto.randomUUID(),
          templateLineId: tl.id,
          categoryId: tl.categoryId,
          description: tl.description,
          qty: storedString(qty),
          unitCost: storedString(unitCost),
          transactionCurrency: input.reportingCurrency,
          fxRateToReporting: "1",
          fxRateSource: "same-currency",
          planned: storedString(t.planned),
          taxCode: tl.taxCode,
          taxAmountPlanned: storedString(t.taxAmountPlanned),
          sortOrder: sort++,
        };
      });
      await tx.budgetLine.createMany({
        data: [
          ...seeded,
          {
            organizationId: input.organizationId,
            budgetId: budget.id,
            lineKey: globalThis.crypto.randomUUID(),
            categoryId: contingencyCat.id,
            description: "Contingency",
            qty: "1",
            unitCost: "0",
            transactionCurrency: input.reportingCurrency,
            fxRateToReporting: "1",
            fxRateSource: "same-currency",
            planned: "0",
            taxAmountPlanned: "0",
            isContingency: true,
            sortOrder: 9999,
          },
        ],
      });
      await recomputeBudgetTotals(tx, budget.id);
      await audit(tx, {
        userId: input.actorUserId,
        organizationId: input.organizationId,
        action: "CREATE",
        entityType: "EventBudget",
        entityId: budget.id,
        changes: { source: input.source, eventId: event.id, eventCode: event.code, templateId: template?.id ?? null, reportingCurrency: input.reportingCurrency, seededLines: seeded.length },
      });
      return budget.id;
    });
    return getBudget(input.organizationId, created);
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return fail("BUDGET_EXISTS", "This event already has a budget.", ctx);
    apiLogger.error({ msg: "procurement/budget:create-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not create the budget.", ctx);
  }
}

// ── header ───────────────────────────────────────────────────────────────────

export interface UpdateBudgetHeaderInput {
  organizationId: string;
  actorUserId: string;
  source: Source;
  budgetId: string;
  expectedVersion: number;
  contingencyPercent?: MoneyInput;
  reportingCurrency?: string;
  brand?: "MMG_EXPERTS" | "MEDCOM" | "MEDULIVE" | null;
  expectedAttendance?: number | null;
  benchmarkSourceType?: "EA_SYS_BUDGET" | "ARCHIVE_SUMMARY" | "NONE";
  benchmarkSourceId?: string | null;
  naCategoryCodes?: string[];
  financeOwnerUserId?: string | null;
  freezeAt?: Date | null;
  notes?: string | null;
}

const DRAFT_ONLY_HEADER: (keyof UpdateBudgetHeaderInput)[] = ["contingencyPercent", "reportingCurrency", "expectedAttendance", "naCategoryCodes", "benchmarkSourceType", "benchmarkSourceId", "brand"];

export async function updateBudgetHeader(input: UpdateBudgetHeaderInput): Promise<BudgetResult<BudgetView>> {
  const ctx = { budgetId: input.budgetId, userId: input.actorUserId };
  const b = await loadBudget(db, input.organizationId, input.budgetId);
  if (!b) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (b.status === "CLOSED" || b.status === "ARCHIVED") return fail("INVALID_STATUS", "A closed budget is read-only.", ctx);
  const touchesDraftOnly = DRAFT_ONLY_HEADER.some((k) => input[k] !== undefined);
  if (touchesDraftOnly && b.status !== "DRAFT") {
    return fail("INVALID_STATUS", "Planned figures, contingency, currency, attendance and the benchmark source change on a draft version only. Create a new version to revise them.", ctx);
  }
  if (input.reportingCurrency && input.reportingCurrency !== b.reportingCurrency) {
    const lineCount = await db.budgetLine.count({ where: { budgetId: b.id, deletedAt: null, isContingency: false } });
    if (lineCount > 0) return fail("CURRENCY_LOCKED", "The reporting currency is fixed once the budget has lines (spec §7.4). Create a new version to change it.", ctx);
  }
  if (input.contingencyPercent !== undefined) {
    const p = money(input.contingencyPercent);
    if (p.lt(0) || p.gt(100)) return fail("INVALID_AMOUNT", "Contingency percent must be between 0 and 100.", ctx);
  }
  if (input.expectedAttendance !== undefined && input.expectedAttendance !== null && input.expectedAttendance < 0) {
    return fail("INVALID_AMOUNT", "Expected attendance cannot be negative.", ctx);
  }
  const data: Prisma.EventBudgetUpdateManyMutationInput = {
    ...(input.contingencyPercent !== undefined ? { contingencyPercent: money(input.contingencyPercent).toString() } : {}),
    ...(input.reportingCurrency !== undefined ? { reportingCurrency: input.reportingCurrency } : {}),
    ...(input.brand !== undefined ? { brand: input.brand } : {}),
    ...(input.expectedAttendance !== undefined ? { expectedAttendance: input.expectedAttendance } : {}),
    ...(input.benchmarkSourceType !== undefined ? { benchmarkSourceType: input.benchmarkSourceType } : {}),
    ...(input.benchmarkSourceId !== undefined ? { benchmarkSourceId: input.benchmarkSourceId } : {}),
    ...(input.naCategoryCodes !== undefined ? { naCategoryCodes: input.naCategoryCodes } : {}),
    ...(input.financeOwnerUserId !== undefined ? { financeOwnerUserId: input.financeOwnerUserId } : {}),
    ...(input.freezeAt !== undefined ? { freezeAt: input.freezeAt } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    version: { increment: 1 },
  };
  try {
    const stale = await tenantTransaction(async (tx) => {
      const res = await tx.eventBudget.updateMany({ where: { id: b.id, organizationId: input.organizationId, version: input.expectedVersion }, data });
      if (res.count === 0) return true;
      if (input.contingencyPercent !== undefined || input.reportingCurrency !== undefined) await recomputeBudgetTotals(tx, b.id);
      await audit(tx, {
        userId: input.actorUserId, organizationId: input.organizationId, action: "UPDATE", entityType: "EventBudget", entityId: b.id,
        changes: { source: input.source, fields: Object.keys(data).filter((k) => k !== "version") },
      });
      return false;
    });
    if (stale) return fail("STALE_WRITE", "Someone else changed this budget. Reload and try again.", ctx);
    return getBudget(input.organizationId, b.id);
  } catch (err) {
    apiLogger.error({ msg: "procurement/budget:header-update-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not update the budget.", ctx);
  }
}

// ── lines ────────────────────────────────────────────────────────────────────

export interface UpsertBudgetLineInput {
  organizationId: string;
  actorUserId: string;
  source: Source;
  budgetId: string;
  lineId?: string | null;
  categoryId?: string;
  description?: string;
  qty?: MoneyInput;
  unitCost?: MoneyInput;
  transactionCurrency?: string;
  fxRateToReporting?: MoneyInput | null;
  taxCode?: string | null;
  /** A catalogue item; null unlinks. The line keeps its own description and category. */
  productId?: string | null;
  taxRatePercent?: MoneyInput | null;
  serviceStart?: Date | null;
  serviceEnd?: Date | null;
  notes?: string | null;
  forecastFinalAmount?: MoneyInput | null;
  forecastReason?: string | null;
  varianceNote?: string | null;
  sortOrder?: number;
}

const PLANNED_FIELDS: (keyof UpsertBudgetLineInput)[] = ["productId", "categoryId", "description", "qty", "unitCost", "transactionCurrency", "fxRateToReporting", "taxCode", "taxRatePercent", "serviceStart", "serviceEnd", "sortOrder"];

export async function upsertBudgetLine(input: UpsertBudgetLineInput): Promise<BudgetResult<BudgetView>> {
  const ctx = { budgetId: input.budgetId, lineId: input.lineId ?? null, userId: input.actorUserId };
  const b = await loadBudget(db, input.organizationId, input.budgetId);
  if (!b) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (b.status === "CLOSED" || b.status === "ARCHIVED") return fail("INVALID_STATUS", "A closed budget is read-only.", ctx);
  const existing = input.lineId
    ? await db.budgetLine.findFirst({ where: { id: input.lineId, budgetId: b.id, deletedAt: null }, select: BUDGET_LINE_SELECT })
    : null;
  if (input.lineId && !existing) return fail("LINE_NOT_FOUND", "The line was not found.", ctx);
  if (existing?.isContingency && PLANNED_FIELDS.some((k) => input[k] !== undefined)) {
    return fail("INVALID_STATUS", "The contingency line follows the contingency percent; change that on the budget.", ctx);
  }
  const touchesPlanned = !existing || PLANNED_FIELDS.some((k) => input[k] !== undefined);
  if (touchesPlanned && b.status !== "DRAFT") {
    return fail("INVALID_STATUS", "Planned figures change on a draft version only. Create a new version, or edit the forecast and notes here.", ctx);
  }
  if (b.status === "FROZEN" && input.forecastFinalAmount !== undefined) {
    // A forecast may still move on a frozen budget: it is the owner's expectation, not the plan.
  }
  let productSku: string | null = existing?.product?.sku ?? null;
  // A line linked to a catalogue item sits under that item's category, which
  // is its account group (17 September 2026): budget against actual per
  // category must total the same as the accounts the items post to.
  let productCategoryId: string | null = null;
  if (input.productId !== undefined) {
    productSku = null;
    if (input.productId) {
      const product = await db.budgetProduct.findFirst({ where: { id: input.productId, organizationId: input.organizationId, isActive: true }, select: { sku: true, categoryId: true } });
      if (!product) return fail("PRODUCT_NOT_FOUND", "The catalogue item was not found or is archived.", ctx);
      productSku = product.sku;
      productCategoryId = product.categoryId;
    }
  } else if (existing?.productId && input.categoryId !== undefined) {
    const product = await db.budgetProduct.findFirst({ where: { id: existing.productId, organizationId: input.organizationId }, select: { categoryId: true } });
    productCategoryId = product?.categoryId ?? null;
  }
  if (productCategoryId && input.categoryId && input.categoryId !== productCategoryId) {
    return fail("CATEGORY_MISMATCH", `A line picked from the catalogue stays under that item's category${productSku ? ` (SKU ${productSku})` : ""}. Unlink the item to file the line elsewhere.`, ctx);
  }
  const categoryId = productCategoryId ?? input.categoryId ?? existing?.categoryId;
  if (!categoryId) return fail("CATEGORY_NOT_FOUND", "A line needs a category.", ctx);
  if (categoryId !== existing?.categoryId) {
    const cat = await db.budgetCategory.findFirst({ where: { id: categoryId, organizationId: input.organizationId, isActive: true, type: "EXPENSE" }, select: { id: true, code: true } });
    if (!cat) return fail("CATEGORY_NOT_FOUND", "The category was not found or is archived.", ctx);
    if (cat.code === CONTINGENCY_CATEGORY_CODE) return fail("INVALID_STATUS", "Contingency is its own line, sized by the percent.", ctx);
  }
  const description = (input.description ?? existing?.description ?? "").trim();
  if (!description) return fail("INVALID_AMOUNT", "A line needs a description.", ctx);
  const currency = input.transactionCurrency ?? existing?.transactionCurrency ?? b.reportingCurrency;
  let rate: MoneyInput = 1;
  if (currency !== b.reportingCurrency) {
    const given = input.fxRateToReporting ?? existing?.fxRateToReporting ?? null;
    if (given === null || money(given).lte(0) || (input.fxRateToReporting === undefined && existing && existing.transactionCurrency !== currency)) {
      return fail("RATE_REQUIRED", `A ${currency} line needs its exchange rate to ${b.reportingCurrency} (spec §7).`, ctx);
    }
    rate = given;
  }
  let totals;
  try {
    totals = lineTotals({
      qty: input.qty ?? existing?.qty ?? 1,
      unitCost: input.unitCost ?? existing?.unitCost ?? 0,
      fxRateToReporting: rate,
      taxRatePercent: input.taxRatePercent !== undefined ? input.taxRatePercent : (existing?.taxRatePercent ?? null),
    });
  } catch (err) {
    return fail("INVALID_AMOUNT", (err as Error).message, ctx);
  }
  if (input.forecastFinalAmount !== undefined && input.forecastFinalAmount !== null) {
    if (money(input.forecastFinalAmount).lt(0)) return fail("INVALID_AMOUNT", "A forecast cannot be negative.", ctx);
    if (!(input.forecastReason ?? existing?.forecastReason)) return fail("INVALID_AMOUNT", "A forecast override needs a reason (spec §6a).", ctx);
  }
  const plannedData = touchesPlanned
    ? {
        productId: input.productId !== undefined ? input.productId : (existing?.productId ?? null),
        categoryId,
        description,
        qty: storedString(input.qty ?? existing?.qty ?? 1),
        unitCost: storedString(input.unitCost ?? existing?.unitCost ?? 0),
        transactionCurrency: currency,
        fxRateToReporting: money(rate).toString(),
        fxRateSource: currency === b.reportingCurrency ? "same-currency" : "manual",
        fxRateAsOf: currency === b.reportingCurrency ? null : new Date(),
        planned: storedString(totals.planned),
        taxAmountPlanned: storedString(totals.taxAmountPlanned),
        taxCode: input.taxCode !== undefined ? input.taxCode : (existing?.taxCode ?? null),
        taxRatePercent: input.taxRatePercent !== undefined ? (input.taxRatePercent === null ? null : money(input.taxRatePercent).toString()) : (existing?.taxRatePercent ?? null),
        serviceStart: input.serviceStart !== undefined ? input.serviceStart : (existing?.serviceStart ?? null),
        serviceEnd: input.serviceEnd !== undefined ? input.serviceEnd : (existing?.serviceEnd ?? null),
        sortOrder: input.sortOrder ?? existing?.sortOrder ?? 0,
      }
    : {};
  const softData = {
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.forecastFinalAmount !== undefined ? { forecastFinalAmount: input.forecastFinalAmount === null ? null : storedString(input.forecastFinalAmount) } : {}),
    ...(input.forecastReason !== undefined ? { forecastReason: input.forecastReason } : {}),
    ...(input.varianceNote !== undefined ? { varianceNote: input.varianceNote } : {}),
  };
  try {
    await tenantTransaction(async (tx) => {
      if (existing) {
        await tx.budgetLine.update({ where: { id: existing.id }, data: { ...plannedData, ...softData } });
      } else {
        const last = await tx.budgetLine.aggregate({ where: { budgetId: b.id, isContingency: false }, _max: { sortOrder: true } });
        await tx.budgetLine.create({
          data: {
            organizationId: input.organizationId,
            budgetId: b.id,
            lineKey: globalThis.crypto.randomUUID(),
            ...(plannedData as typeof plannedData & { categoryId: string; description: string; transactionCurrency: string }),
            sortOrder: input.sortOrder ?? (last._max.sortOrder ?? -1) + 1,
            ...softData,
          },
        });
      }
      await recomputeBudgetTotals(tx, b.id);
      await tx.eventBudget.update({ where: { id: b.id }, data: { version: { increment: 1 } } });
      await audit(tx, {
        userId: input.actorUserId, organizationId: input.organizationId, action: existing ? "UPDATE" : "CREATE", entityType: "BudgetLine",
        entityId: existing?.id ?? b.id, changes: { source: input.source, budgetId: b.id, description, planned: storedString(totals.planned), touchesPlanned, productSku },
      });
    });
    return getBudget(input.organizationId, b.id);
  } catch (err) {
    apiLogger.error({ msg: "procurement/budget:line-upsert-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not save the line.", ctx);
  }
}

export async function deleteBudgetLine(input: { organizationId: string; actorUserId: string; source: Source; budgetId: string; lineId: string }): Promise<BudgetResult<BudgetView>> {
  const ctx = { budgetId: input.budgetId, lineId: input.lineId, userId: input.actorUserId };
  const b = await loadBudget(db, input.organizationId, input.budgetId);
  if (!b) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (b.status !== "DRAFT") return fail("INVALID_STATUS", "Lines are removed on a draft version only.", ctx);
  const line = await db.budgetLine.findFirst({ where: { id: input.lineId, budgetId: b.id, deletedAt: null }, select: { id: true, isContingency: true, committedOpen: true, description: true } });
  if (!line) return fail("LINE_NOT_FOUND", "The line was not found.", ctx);
  if (line.isContingency) return fail("INVALID_STATUS", "The contingency line cannot be removed; set the percent to zero.", ctx);
  if (money(line.committedOpen).gt(0)) return fail("LINE_HAS_COMMITMENTS", "This line has open commitments; reassign them before removing it (spec §5).", ctx);
  try {
    await tenantTransaction(async (tx) => {
      await tx.budgetLine.update({ where: { id: line.id }, data: { deletedAt: new Date() } });
      await recomputeBudgetTotals(tx, b.id);
      await tx.eventBudget.update({ where: { id: b.id }, data: { version: { increment: 1 } } });
      await audit(tx, { userId: input.actorUserId, organizationId: input.organizationId, action: "DELETE", entityType: "BudgetLine", entityId: line.id, changes: { source: input.source, budgetId: b.id, description: line.description } });
    });
    return getBudget(input.organizationId, b.id);
  } catch (err) {
    apiLogger.error({ msg: "procurement/budget:line-delete-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not remove the line.", ctx);
  }
}

// ── submit / decide / activate ───────────────────────────────────────────────

/** The reason a rate was refused, in the caller's words (spec §7.3: one rate, never the requester's choice). */
function rateRefusal(currency: string, r: Extract<RateResolution, { ok: false }>, purpose: string): string {
  return r.reason === "missing"
    ? `The ${currency} to AED rate is needed ${purpose}.`
    : `The ${currency} to AED rate must be between ${FLOATING_TO_AED_BAND.min} and ${FLOATING_TO_AED_BAND.max}.`;
}

export async function submitBudget(input: { organizationId: string; actorUserId: string; source: Source; budgetId: string; reportingToAedRate?: MoneyInput | null }): Promise<BudgetResult<BudgetView>> {
  const ctx = { budgetId: input.budgetId, userId: input.actorUserId };
  const b = await loadBudget(db, input.organizationId, input.budgetId);
  if (!b) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (b.status !== "DRAFT") return fail("INVALID_STATUS", "Only a draft can be submitted.", ctx);
  const lines = await loadLines(db, b.id);
  const categories = await db.budgetCategory.findMany({ where: { organizationId: input.organizationId }, select: { id: true, code: true, depth: true, isActive: true } });
  const missing = missingForSubmission(b, lines, categories, CONTINGENCY_CATEGORY_CODE);
  if (missing.length > 0) return fail("INCOMPLETE", "The budget is not complete enough to submit.", ctx, { missing });
  const aed = resolveReportingToAedRate(b.reportingCurrency, input.reportingToAedRate);
  if (!aed.ok) return fail("RATE_REQUIRED", rateRefusal(b.reportingCurrency, aed, "to route the approval (spec §7.3)"), ctx);
  const amountAed = toAed(b.plannedExpenseTotal, aed.rate);
  const rateUsed = { reportingToAedRate: aed.rate.toString(), rateSource: aed.source };
  try {
    const outcome = await tenantTransaction(async (tx) => {
      const req = await createApprovalRequest(tx, {
        organizationId: input.organizationId,
        subjectType: "BUDGET",
        subjectId: b.id,
        amountAed: Number(amountAed.toString()),
        amount: storedString(b.plannedExpenseTotal),
        currency: b.reportingCurrency,
        requesterUserId: input.actorUserId,
        // The rate that routed it travels with the request, so the approver
        // sees the conversion and not only its result.
        payload: rateUsed,
        source: input.source,
      });
      if (!req.ok) return req;
      const res = await tx.eventBudget.updateMany({ where: { id: b.id, organizationId: input.organizationId, status: "DRAFT" }, data: { status: "UNDER_REVIEW", submittedAt: new Date(), version: { increment: 1 } } });
      if (res.count === 0) throw new Error("STALE");
      await audit(tx, { userId: input.actorUserId, organizationId: input.organizationId, action: "SUBMIT", entityType: "EventBudget", entityId: b.id, changes: { source: input.source, amountAed: amountAed.toString(), ...rateUsed, approvalRequestId: req.request.id } });
      return req;
    });
    if (!outcome.ok) return fail("NO_APPROVER", outcome.message, ctx);
    return getBudget(input.organizationId, b.id);
  } catch (err) {
    if ((err as Error).message === "STALE") return fail("STALE_WRITE", "The budget changed while you were submitting it. Reload.", ctx);
    apiLogger.error({ msg: "procurement/budget:submit-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not submit the budget.", ctx);
  }
}

export async function decideBudget(input: { organizationId: string; decider: ProcurementUserLike & { id: string }; source: Source; budgetId: string; decision: "APPROVED" | "REJECTED"; note?: string | null }): Promise<BudgetResult<BudgetView>> {
  const ctx = { budgetId: input.budgetId, userId: input.decider.id };
  const b = await loadBudget(db, input.organizationId, input.budgetId);
  if (!b) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (b.status !== "UNDER_REVIEW") return fail("INVALID_STATUS", "This budget is not awaiting a decision.", ctx);
  const request = await db.approvalRequest.findFirst({ where: { organizationId: input.organizationId, subjectType: "BUDGET", subjectId: b.id, status: "PENDING" }, select: { id: true } });
  if (!request) return fail("APPROVAL_FAILED", "No pending approval request exists for this budget.", ctx);
  try {
    const outcome = await tenantTransaction(async (tx) => {
      const d = await decideApprovalRequest(tx, { organizationId: input.organizationId, requestId: request.id, decider: input.decider, decision: input.decision, note: input.note, source: input.source });
      if (!d.ok) return d;
      const now = new Date();
      if (input.decision === "REJECTED") {
        await tx.eventBudget.updateMany({ where: { id: b.id, status: "UNDER_REVIEW" }, data: { status: "DRAFT", version: { increment: 1 } } });
        await audit(tx, { userId: input.decider.id, organizationId: input.organizationId, action: "REJECT", entityType: "EventBudget", entityId: b.id, changes: { source: input.source, note: input.note ?? null } });
        return d;
      }
      // Activate: the previous active version of this event steps aside in
      // the same transaction, so exactly one version is ever ACTIVE. The
      // committed-figures lock comes first: an order issued or cancelled at
      // this moment takes it before touching budget rows, so taking it after
      // archiving could deadlock.
      await lockEventCommitted(tx, input.organizationId, b.id);
      if (b.eventId) {
        await tx.eventBudget.updateMany({ where: { eventId: b.eventId, status: { in: ["ACTIVE", "FROZEN"] }, id: { not: b.id } }, data: { status: "ARCHIVED", version: { increment: 1 } } });
      }
      const res = await tx.eventBudget.updateMany({
        where: { id: b.id, status: "UNDER_REVIEW" },
        data: { status: "ACTIVE", approvedAt: now, approvedByUserId: input.decider.id, activatedAt: now, version: { increment: 1 } },
      });
      if (res.count === 0) throw new Error("STALE");
      const lines = await loadLines(tx, b.id);
      for (const l of lines) {
        await tx.budgetLine.update({ where: { id: l.id }, data: { approvedPlanned: storedString(l.planned), reallocatedOut: "0" } });
      }
      // Orders issued on the previous version after this one was drafted, or cancelled since, are counted here.
      await syncBudgetCommitted(tx, input.organizationId, b.id);
      await recomputeBudgetTotals(tx, b.id);
      await audit(tx, { userId: input.decider.id, organizationId: input.organizationId, action: "APPROVE", entityType: "EventBudget", entityId: b.id, changes: { source: input.source, note: input.note ?? null, versionNo: b.versionNo } });
      return d;
    });
    if (!outcome.ok) return fail("APPROVAL_FAILED", outcome.message, ctx, { code: outcome.code });
    return getBudget(input.organizationId, b.id);
  } catch (err) {
    if ((err as Error).message === "STALE") return fail("STALE_WRITE", "The budget changed while it was being decided. Reload.", ctx);
    apiLogger.error({ msg: "procurement/budget:decide-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not record the decision.", ctx);
  }
}

// ── versions ─────────────────────────────────────────────────────────────────

export async function newBudgetVersion(input: { organizationId: string; actorUserId: string; source: Source; budgetId: string }): Promise<BudgetResult<BudgetView>> {
  const ctx = { budgetId: input.budgetId, userId: input.actorUserId };
  const b = await loadBudget(db, input.organizationId, input.budgetId);
  if (!b) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (b.status !== "ACTIVE") return fail("INVALID_STATUS", "A new version starts from the active version.", ctx);
  if (!b.eventId) return fail("INVALID_STATUS", "An entity-level budget has no versions yet.", ctx);
  const inProgress = await db.eventBudget.count({ where: { eventId: b.eventId, status: { in: ["DRAFT", "UNDER_REVIEW"] } } });
  if (inProgress > 0) return fail("VERSION_IN_PROGRESS", "A draft or submitted version already exists for this event. Finish or discard it first.", ctx);
  try {
    const newId = await tenantTransaction(async (tx) => {
      const max = await tx.eventBudget.aggregate({ where: { eventId: b.eventId! }, _max: { versionNo: true } });
      const created = await tx.eventBudget.create({
        data: {
          organizationId: input.organizationId,
          eventId: b.eventId,
          eventCode: b.eventCode,
          versionNo: (max._max.versionNo ?? b.versionNo) + 1,
          brand: b.brand,
          reportingCurrency: b.reportingCurrency,
          contingencyPercent: money(b.contingencyPercent).toString(),
          expectedAttendance: b.expectedAttendance,
          benchmarkSourceType: b.benchmarkSourceType,
          benchmarkSourceId: b.benchmarkSourceId,
          ownerUserId: b.ownerUserId,
          financeOwnerUserId: b.financeOwnerUserId,
          naCategoryCodes: b.naCategoryCodes,
          freezeAt: b.freezeAt,
          notes: b.notes,
          createdByUserId: input.actorUserId,
        },
        select: { id: true },
      });
      const lines = await loadLines(tx, b.id);
      await tx.budgetLine.createMany({
        data: lines.map((l) => ({ organizationId: input.organizationId, budgetId: created.id, ...cloneLineForNewVersion(l) })),
      });
      await recomputeBudgetTotals(tx, created.id);
      await audit(tx, { userId: input.actorUserId, organizationId: input.organizationId, action: "NEW_VERSION", entityType: "EventBudget", entityId: created.id, changes: { source: input.source, fromBudgetId: b.id, fromVersionNo: b.versionNo, lines: lines.length } });
      return created.id;
    });
    return getBudget(input.organizationId, newId);
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return fail("VERSION_IN_PROGRESS", "A version with that number already exists. Reload.", ctx);
    apiLogger.error({ msg: "procurement/budget:new-version-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not create the new version.", ctx);
  }
}

// ── reallocation ─────────────────────────────────────────────────────────────

export interface ReallocateInput {
  organizationId: string;
  actorUserId: string;
  actor: ProcurementUserLike & { id: string };
  source: Source;
  budgetId: string;
  fromLineKey: string;
  toLineKey: string;
  amount: MoneyInput;
  reason: string;
  reportingToAedRate?: MoneyInput | null;
}

const REALLOCATION_LINE_SELECT = { id: true, planned: true, approvedPlanned: true, reallocatedOut: true, fxRateToReporting: true, taxRatePercent: true, isContingency: true, deletedAt: true } as const;

/**
 * A moved amount is a new planned figure for the line: qty becomes 1, the unit
 * cost is the planned amount back in the line's own currency (so a later edit
 * on a cloned version recomputes qty × unitCost × rate to the same planned
 * figure), and the planned tax follows the new amount at the line's rate.
 */
function replanned(planned: ReturnType<typeof money>, line: { fxRateToReporting: unknown; taxRatePercent: unknown }) {
  const rate = money(line.fxRateToReporting as MoneyInput);
  const taxPct = money((line.taxRatePercent ?? 0) as MoneyInput);
  return {
    planned: storedString(planned),
    qty: "1",
    unitCost: storedString(planned.div(rate)),
    taxAmountPlanned: storedString(planned.mul(taxPct).div(100)),
  };
}

async function applyReallocation(tx: Db, budgetId: string, move: { fromLineKey: string; toLineKey: string; amount: string }, countAgainstOwner: boolean) {
  const fromRef = await tx.budgetLine.findFirst({ where: { budgetId, lineKey: move.fromLineKey, deletedAt: null }, select: { id: true } });
  const toRef = await tx.budgetLine.findFirst({ where: { budgetId, lineKey: move.toLineKey, deletedAt: null }, select: { id: true } });
  if (!fromRef || !toRef) throw new Error("LINE_NOT_FOUND");
  // Lock both rows for the rest of the transaction, always in id order so two
  // opposite moves cannot deadlock, and only THEN read the figures: what the
  // caller read before the lock may be a move behind (two clicks, two tabs).
  // Holds through the pooler inside an interactive transaction (the
  // createCreditNote pattern).
  for (const id of [fromRef.id, toRef.id].sort()) await tx.$queryRaw`SELECT id FROM "BudgetLine" WHERE id = ${id} FOR UPDATE`;
  const from = await tx.budgetLine.findUnique({ where: { id: fromRef.id }, select: REALLOCATION_LINE_SELECT });
  const to = await tx.budgetLine.findUnique({ where: { id: toRef.id }, select: REALLOCATION_LINE_SELECT });
  if (!from || !to || from.deletedAt || to.deletedAt) throw new Error("LINE_NOT_FOUND");
  // The contingency line is sized by the percent: recomputeBudgetTotals below
  // would put it straight back, and the amount would leave the source line and
  // land nowhere. Refused here as well as at the request, so a request that
  // was queued before this guard cannot apply either.
  if (to.isContingency) throw new Error("CONTINGENCY_TARGET");
  const amt = money(move.amount);
  if (money(from.planned).minus(amt).lt(0)) throw new Error("INVALID_AMOUNT");
  // The owner's 10% is judged on the LOCKED row: a move that landed between the
  // caller's check and this lock counts, so two moves cannot add up past the cap.
  if (countAgainstOwner && reallocationAuthority(from, amt) !== "OWNER") throw new Error("CAP_EXCEEDED");
  const fromPlanned = money(from.planned).minus(amt);
  const toPlanned = money(to.planned).plus(amt);
  await tx.budgetLine.update({ where: { id: from.id }, data: { ...replanned(fromPlanned, from), ...(countAgainstOwner ? { reallocatedOut: storedString(money(from.reallocatedOut).plus(amt)) } : {}) } });
  await tx.budgetLine.update({ where: { id: to.id }, data: replanned(toPlanned, to) });
  await recomputeBudgetTotals(tx, budgetId);
  await tx.eventBudget.update({ where: { id: budgetId }, data: { version: { increment: 1 } } });
}

export async function reallocateBudget(input: ReallocateInput): Promise<BudgetResult<BudgetView> | { ok: true; budget: BudgetView; pendingApprovalId: string }> {
  const ctx = { budgetId: input.budgetId, userId: input.actorUserId };
  const b = await loadBudget(db, input.organizationId, input.budgetId);
  if (!b) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (b.status !== "ACTIVE") return fail("INVALID_STATUS", "Planned amounts move on the active version only; a frozen budget's plan is locked (spec §6a).", ctx);
  if (input.fromLineKey === input.toLineKey) return fail("INVALID_AMOUNT", "Pick two different lines.", ctx);
  const amt = money(input.amount);
  if (amt.lte(0)) return fail("INVALID_AMOUNT", "A reallocation moves a positive amount.", ctx);
  if (!input.reason.trim()) return fail("INVALID_AMOUNT", "A reallocation needs a reason.", ctx);
  const from = await db.budgetLine.findFirst({ where: { budgetId: b.id, lineKey: input.fromLineKey, deletedAt: null }, select: { id: true, planned: true, approvedPlanned: true, reallocatedOut: true, isContingency: true, description: true } });
  const to = await db.budgetLine.findFirst({ where: { budgetId: b.id, lineKey: input.toLineKey, deletedAt: null }, select: { id: true, description: true, isContingency: true } });
  if (!from || !to) return fail("LINE_NOT_FOUND", "One of the lines was not found on this budget.", ctx);
  if (from.isContingency) return fail("INVALID_STATUS", "A draw from contingency is a spend request against that line, not a reallocation (spec §6a).", ctx);
  if (to.isContingency) return fail("INVALID_STATUS", "Contingency is sized by the percent and cannot receive a reallocation; raise the percent on the budget instead (spec §6a).", ctx);
  if (money(from.planned).lt(amt)) return fail("INVALID_AMOUNT", `The line "${from.description}" holds only ${storedString(from.planned)}.`, ctx);
  const authority = reallocationAuthority(from, amt);
  const move = { fromLineKey: input.fromLineKey, toLineKey: input.toLineKey, amount: storedString(amt) };
  try {
    if (authority === "OWNER") {
      await tenantTransaction(async (tx) => {
        await applyReallocation(tx, b.id, move, true);
        await audit(tx, { userId: input.actorUserId, organizationId: input.organizationId, action: "REALLOCATE", entityType: "EventBudget", entityId: b.id, changes: { source: input.source, ...move, reason: input.reason, authority } });
      });
      return getBudget(input.organizationId, b.id);
    }
    const aed = resolveReportingToAedRate(b.reportingCurrency, input.reportingToAedRate);
    if (!aed.ok) return fail("RATE_REQUIRED", rateRefusal(b.reportingCurrency, aed, "because this move is above your 10% authority and routes for approval"), ctx);
    const rateUsed = { reportingToAedRate: aed.rate.toString(), rateSource: aed.source };
    const outcome = await tenantTransaction(async (tx) => {
      const req = await createApprovalRequest(tx, {
        organizationId: input.organizationId,
        subjectType: "BUDGET_REALLOCATION",
        subjectId: b.id,
        amountAed: Number(toAed(amt, aed.rate).toString()),
        amount: storedString(amt),
        currency: b.reportingCurrency,
        requesterUserId: input.actorUserId,
        reason: input.reason,
        payload: { ...move, ...rateUsed },
        source: input.source,
      });
      if (!req.ok) return req;
      await audit(tx, { userId: input.actorUserId, organizationId: input.organizationId, action: "REALLOCATION_REQUESTED", entityType: "EventBudget", entityId: b.id, changes: { source: input.source, ...move, ...rateUsed, reason: input.reason, approvalRequestId: req.request.id } });
      return req;
    });
    if (!outcome.ok) return fail("NO_APPROVER", outcome.message, ctx);
    const view = await getBudget(input.organizationId, b.id);
    if (!view.ok) return view;
    return { ok: true, budget: view.budget, pendingApprovalId: outcome.request.id };
  } catch (err) {
    const m = (err as Error).message;
    if (m === "CAP_EXCEEDED") return fail("CAP_EXCEEDED", "Another move on this line landed first and this one now exceeds your 10% authority. Reload, then route it for approval.", ctx);
    if (m === "INVALID_AMOUNT") return fail("INVALID_AMOUNT", "The source line no longer holds that amount. Reload.", ctx);
    if (m === "LINE_NOT_FOUND") return fail("LINE_NOT_FOUND", "A line in the move no longer exists. Reload.", ctx);
    if (m === "CONTINGENCY_TARGET") return fail("INVALID_STATUS", "Contingency cannot receive a reallocation.", ctx);
    apiLogger.error({ msg: "procurement/budget:reallocate-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not move the amount.", ctx);
  }
}

export async function decideReallocation(input: { organizationId: string; decider: ProcurementUserLike & { id: string }; source: Source; requestId: string; decision: "APPROVED" | "REJECTED"; note?: string | null }): Promise<BudgetResult<BudgetView>> {
  const ctx = { requestId: input.requestId, userId: input.decider.id };
  const request = await db.approvalRequest.findFirst({ where: { id: input.requestId, organizationId: input.organizationId, subjectType: "BUDGET_REALLOCATION" }, select: { id: true, subjectId: true, payload: true, status: true } });
  if (!request) return fail("APPROVAL_FAILED", "The reallocation request was not found.", ctx);
  const move = request.payload as { fromLineKey: string; toLineKey: string; amount: string } | null;
  if (!move?.fromLineKey || !move.toLineKey || !move.amount) return fail("APPROVAL_FAILED", "The request carries no move to apply.", ctx);
  try {
    const outcome = await tenantTransaction(async (tx) => {
      const d = await decideApprovalRequest(tx, { organizationId: input.organizationId, requestId: request.id, decider: input.decider, decision: input.decision, note: input.note, source: input.source });
      if (!d.ok) return d;
      if (input.decision === "APPROVED") {
        const b = await tx.eventBudget.findFirst({ where: { id: request.subjectId, organizationId: input.organizationId }, select: { status: true } });
        if (b?.status !== "ACTIVE") throw new Error("INVALID_STATUS");
        await applyReallocation(tx, request.subjectId, move, false);
      }
      await audit(tx, { userId: input.decider.id, organizationId: input.organizationId, action: input.decision === "APPROVED" ? "REALLOCATE" : "REALLOCATION_REJECTED", entityType: "EventBudget", entityId: request.subjectId, changes: { source: input.source, ...move, approvalRequestId: request.id, note: input.note ?? null } });
      return d;
    });
    if (!outcome.ok) return fail("APPROVAL_FAILED", outcome.message, ctx, { code: outcome.code });
    return getBudget(input.organizationId, request.subjectId);
  } catch (err) {
    const m = (err as Error).message;
    if (m === "INVALID_STATUS") return fail("INVALID_STATUS", "The budget is no longer active; the move was not applied.", ctx);
    if (m === "LINE_NOT_FOUND") return fail("LINE_NOT_FOUND", "A line in the move no longer exists.", ctx);
    if (m === "INVALID_AMOUNT") return fail("INVALID_AMOUNT", "The source line no longer holds that amount.", ctx);
    if (m === "CONTINGENCY_TARGET") return fail("INVALID_STATUS", "Contingency cannot receive a reallocation; reject this request.", ctx);
    apiLogger.error({ msg: "procurement/budget:decide-reallocation-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not record the decision.", ctx);
  }
}

// ── freeze / close / sign-off / reopen ───────────────────────────────────────

async function transition(input: { organizationId: string; actorUserId: string; source: Source; budgetId: string; from: BudgetRow["status"][]; to: BudgetRow["status"]; action: string; data?: Prisma.EventBudgetUpdateManyMutationInput; changes?: Prisma.InputJsonObject }): Promise<BudgetResult<BudgetView>> {
  const ctx = { budgetId: input.budgetId, userId: input.actorUserId };
  const b = await loadBudget(db, input.organizationId, input.budgetId);
  if (!b) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (!input.from.includes(b.status)) return fail("INVALID_STATUS", `A ${b.status.toLowerCase().replace("_", " ")} budget cannot move to ${input.to.toLowerCase()}.`, ctx);
  try {
    await tenantTransaction(async (tx) => {
      const res = await tx.eventBudget.updateMany({ where: { id: b.id, organizationId: input.organizationId, status: { in: input.from } }, data: { status: input.to, version: { increment: 1 }, ...(input.data ?? {}) } });
      if (res.count === 0) throw new Error("STALE");
      await audit(tx, { userId: input.actorUserId, organizationId: input.organizationId, action: input.action, entityType: "EventBudget", entityId: b.id, changes: { source: input.source, from: b.status, to: input.to, ...(input.changes ?? {}) } });
    });
    return getBudget(input.organizationId, b.id);
  } catch (err) {
    if ((err as Error).message === "STALE") return fail("STALE_WRITE", "The budget changed under you. Reload.", ctx);
    apiLogger.error({ msg: "procurement/budget:transition-failed", err, action: input.action, ...ctx });
    return fail("UNKNOWN", "Could not update the budget.", ctx);
  }
}

export function freezeBudget(input: { organizationId: string; actorUserId: string; source: Source; budgetId: string }) {
  return transition({ ...input, from: ["ACTIVE"], to: "FROZEN", action: "FREEZE", data: { frozenAt: new Date() } });
}
export function unfreezeBudget(input: { organizationId: string; actorUserId: string; source: Source; budgetId: string; reason: string }) {
  return transition({ ...input, from: ["FROZEN"], to: "ACTIVE", action: "UNFREEZE", data: { frozenAt: null }, changes: { reason: input.reason } });
}

export interface CloseBudgetInput {
  organizationId: string;
  actorUserId: string;
  source: Source;
  budgetId: string;
  varianceNotes?: Record<string, string>;
  reportingToAedRate?: MoneyInput | null;
}

export async function closeBudget(input: CloseBudgetInput): Promise<BudgetResult<BudgetView>> {
  const ctx = { budgetId: input.budgetId, userId: input.actorUserId };
  const b = await loadBudget(db, input.organizationId, input.budgetId);
  if (!b) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (b.status !== "ACTIVE" && b.status !== "FROZEN") return fail("INVALID_STATUS", "Only the active or frozen version closes.", ctx);
  const aed = resolveReportingToAedRate(b.reportingCurrency, input.reportingToAedRate);
  if (!aed.ok) return fail("RATE_REQUIRED", rateRefusal(b.reportingCurrency, aed, "for the variance threshold (spec §14 Q13)"), ctx);
  const lines = await loadLines(db, b.id);
  // The AED-5,000 floor expressed in the reporting currency.
  const floor = VARIANCE_NOTE_FLOOR_AED.div(aed.rate);
  const notes = input.varianceNotes ?? {};
  const needing = lines.filter((l) => !l.isContingency && varianceRequiresNote({ planned: l.planned, actual: l.actual, floorInReporting: floor }) && !(notes[l.lineKey]?.trim() || l.varianceNote?.trim()));
  if (needing.length > 0) {
    return fail("VARIANCE_NOTES_REQUIRED", "Every line whose actual differs from planned past the threshold needs a written explanation.", ctx, { lineKeys: needing.map((l) => l.lineKey) });
  }
  const recordedAttendance = b.eventId
    ? await db.registration.count({ where: { eventId: b.eventId, status: "CHECKED_IN", ...EXCLUDE_FACULTY_WHERE } })
    : null;
  const byCategory: Record<string, { planned: string; actual: string; variance: string }> = {};
  const acc = new Map<string, { planned: ReturnType<typeof money>; actual: ReturnType<typeof money> }>();
  for (const l of lines) {
    const cur = acc.get(l.category.code) ?? { planned: money(0), actual: money(0) };
    acc.set(l.category.code, { planned: cur.planned.plus(money(l.planned)), actual: cur.actual.plus(money(l.actual)) });
  }
  for (const [code, v] of acc) byCategory[code] = { planned: storedString(v.planned), actual: storedString(v.actual), variance: storedString(v.actual.minus(v.planned)) };
  const expenseTotal = lines.reduce((a, l) => a.plus(money(l.actual)), money(0));
  const summary = { closedAt: new Date().toISOString(), plannedExpenseTotal: storedString(b.plannedExpenseTotal), actualTotal: storedString(expenseTotal), contingencyAmount: storedString(b.contingencyAmount), recordedAttendance, byCategory };
  const event = b.eventId ? await db.event.findUnique({ where: { id: b.eventId }, select: { name: true, startDate: true, eventType: true } }) : null;
  try {
    await tenantTransaction(async (tx) => {
      for (const l of lines) {
        const note = notes[l.lineKey]?.trim();
        if (note) await tx.budgetLine.update({ where: { id: l.id }, data: { varianceNote: note } });
      }
      const res = await tx.eventBudget.updateMany({
        where: { id: b.id, organizationId: input.organizationId, status: { in: ["ACTIVE", "FROZEN"] } },
        data: { status: "CLOSED", closedAt: new Date(), closedByUserId: input.actorUserId, recordedAttendance, closeOutSummary: summary, version: { increment: 1 } },
      });
      if (res.count === 0) throw new Error("STALE");
      // The archive row every cross-event and benchmark report reads (spec §13a):
      // rewritten if the budget is reopened and closed again.
      await tx.eventFinancialSummary.upsert({
        where: { organizationId_sourceSystem_eventCode: { organizationId: input.organizationId, sourceSystem: "EA_SYS", eventCode: b.eventCode } },
        create: {
          organizationId: input.organizationId, sourceSystem: "EA_SYS", eventCode: b.eventCode, name: event?.name ?? b.eventCode,
          year: (event?.startDate ?? new Date()).getUTCFullYear(), eventType: event?.eventType ?? null, brand: b.brand, attendance: recordedAttendance,
          currency: b.reportingCurrency, categoryTotals: byCategory, expenseTotal: storedString(expenseTotal), asOf: new Date(), eventBudgetId: b.id,
        },
        update: {
          name: event?.name ?? b.eventCode, year: (event?.startDate ?? new Date()).getUTCFullYear(), eventType: event?.eventType ?? null, brand: b.brand,
          attendance: recordedAttendance, currency: b.reportingCurrency, categoryTotals: byCategory, expenseTotal: storedString(expenseTotal), asOf: new Date(), eventBudgetId: b.id,
        },
      });
      await audit(tx, { userId: input.actorUserId, organizationId: input.organizationId, action: "CLOSE", entityType: "EventBudget", entityId: b.id, changes: { source: input.source, recordedAttendance, actualTotal: storedString(expenseTotal), notesWritten: Object.keys(notes).length, reportingToAedRate: aed.rate.toString(), rateSource: aed.source, varianceFloorInReporting: storedString(floor) } });
    });
    return getBudget(input.organizationId, b.id);
  } catch (err) {
    if ((err as Error).message === "STALE") return fail("STALE_WRITE", "The budget changed under you. Reload.", ctx);
    apiLogger.error({ msg: "procurement/budget:close-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not close the budget.", ctx);
  }
}

export function signOffBudget(input: { organizationId: string; actorUserId: string; source: Source; budgetId: string }) {
  return transition({ ...input, from: ["CLOSED"], to: "CLOSED", action: "SIGN_OFF", data: { signedOffAt: new Date(), signedOffByUserId: input.actorUserId } });
}
export async function reopenBudget(input: { organizationId: string; actorUserId: string; source: Source; budgetId: string; reason: string }): Promise<BudgetResult<BudgetView>> {
  // Reopening undoes a close-out and a sign-off; the trail must say why.
  if (!input.reason.trim()) return fail("INVALID_AMOUNT", "A reopen needs a reason (spec §6a).", { budgetId: input.budgetId, userId: input.actorUserId });
  return transition({ ...input, from: ["CLOSED"], to: "ACTIVE", action: "REOPEN", data: { closedAt: null, closedByUserId: null, signedOffAt: null, signedOffByUserId: null }, changes: { reason: input.reason.trim() } });
}

/** A draft that will not be pursued: its pending approval (if any) is cancelled and the row deleted; only drafts, and only version 1 or a clone. */
export async function discardDraftBudget(input: { organizationId: string; actorUserId: string; source: Source; budgetId: string }): Promise<BudgetResult<{ id: string }>> {
  const ctx = { budgetId: input.budgetId, userId: input.actorUserId };
  const b = await loadBudget(db, input.organizationId, input.budgetId);
  if (!b) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (b.status !== "DRAFT" && b.status !== "UNDER_REVIEW") return fail("INVALID_STATUS", "Only a draft or submitted version can be discarded.", ctx);
  try {
    await tenantTransaction(async (tx) => {
      await cancelPendingApprovals(tx, { organizationId: input.organizationId, subjectType: "BUDGET", subjectId: b.id, actorUserId: input.actorUserId, source: input.source });
      await tx.eventBudget.delete({ where: { id: b.id } });
      await audit(tx, { userId: input.actorUserId, organizationId: input.organizationId, action: "DISCARD", entityType: "EventBudget", entityId: b.id, changes: { source: input.source, versionNo: b.versionNo, status: b.status } });
    });
    return { ok: true, budget: { id: b.id } };
  } catch (err) {
    apiLogger.error({ msg: "procurement/budget:discard-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not discard the draft.", ctx);
  }
}

export const contingencyForPercent = contingencyAmount;
