/**
 * Budget revenue (spec §6b; owner decisions of 17 September 2026): planned
 * revenue lines per income account, and the actuals and margin read at request
 * time from what EA-SYS and the CRM already hold.
 *
 * Planned lines follow the expense rule: typed on a DRAFT version, approved
 * with the budget, changed later only through a new version. Actuals are
 * never typed or stored while the budget is open; `readRevenueActuals` reads
 * paid registrations and won deals linked to the event, and close-out keeps
 * the figures it read. The rules that decide each figure are in
 * lib/revenue-rules.ts.
 *
 * ONE implementation for the routes, the close-out and the version clone.
 * Errors as values; runs inside the caller's tenant lane.
 */
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { Prisma } from "@prisma/client";
import type { Db } from "@/lib/approvals/approvals-service";
import { readRegistrationBasePrice } from "@/lib/registration-financials";
import { INCOME_ACCOUNTS } from "../lib/income-accounts";
import { lineTotals, money, storedString, type MoneyInput } from "../lib/money";
import { aggregateActuals, marginView, type MarginView, type RevenueActuals } from "../lib/revenue-rules";

export type RevenueErrorCode = "BUDGET_NOT_FOUND" | "LINE_NOT_FOUND" | "CATEGORY_NOT_FOUND" | "INVALID_STATUS" | "RATE_REQUIRED" | "INVALID_AMOUNT" | "UNKNOWN";
export type RevenueResult<T> = { ok: true; value: T } | { ok: false; code: RevenueErrorCode; message: string };
type Source = "ui" | "mcp";

export const REVENUE_LINE_SELECT = {
  id: true, lineKey: true, categoryId: true, description: true, qty: true, unitAmount: true, transactionCurrency: true,
  fxRateToReporting: true, fxRateSource: true, fxRateAsOf: true, planned: true, notes: true, sortOrder: true, createdAt: true, updatedAt: true,
  category: { select: { id: true, code: true, name: true } },
} as const;
type RevenueLineRow = Prisma.BudgetRevenueLineGetPayload<{ select: typeof REVENUE_LINE_SELECT }>;

function toRevenueLineView(l: RevenueLineRow) {
  return {
    ...l,
    qty: storedString(l.qty),
    unitAmount: storedString(l.unitAmount),
    fxRateToReporting: money(l.fxRateToReporting).toString(),
    planned: storedString(l.planned),
  };
}
export type RevenueLineView = ReturnType<typeof toRevenueLineView>;

function fail(code: RevenueErrorCode, message: string, ctx: Record<string, unknown> = {}): RevenueResult<never> {
  apiLogger.warn({ msg: "procurement/revenue:rejected", code, ...ctx });
  return { ok: false, code, message };
}

const CATEGORY_SELECT = { id: true, code: true, name: true, isActive: true, sortOrder: true } as const;

/**
 * The income-account categories, seeded ONCE per organisation: an organisation
 * holding any revenue category, even after archiving some, is never
 * re-seeded, so an admin's edits stand (the expense categories' rule). The
 * seed is idempotent under concurrency: `@@unique([organizationId, code])`.
 */
export async function ensureRevenueCategories(organizationId: string) {
  const where = { organizationId, type: "REVENUE" as const };
  const existing = await db.budgetCategory.findMany({ where, select: CATEGORY_SELECT, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] });
  if (existing.length > 0) return existing;
  try {
    await db.budgetCategory.createMany({
      data: INCOME_ACCOUNTS.map((a, i) => ({ organizationId, code: a.code, name: a.name, type: "REVENUE" as const, depth: 0, sortOrder: 100 + i })),
      skipDuplicates: true,
    });
    apiLogger.info({ msg: "procurement/revenue:categories-seeded", organizationId, count: INCOME_ACCOUNTS.length });
  } catch (err) {
    apiLogger.warn({ msg: "procurement/revenue:categories-seed-raced", organizationId, err });
  }
  return db.budgetCategory.findMany({ where, select: CATEGORY_SELECT, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] });
}

/** Paid registrations and won deals for the event, aggregated per income account in the reporting currency. */
export async function readRevenueActuals(organizationId: string, eventId: string | null, reportingCurrency: string): Promise<RevenueActuals> {
  if (!eventId) return aggregateActuals({ reportingCurrency, taxRatePercent: null, registrations: [], deals: [] });
  const [event, registrations, deals] = await Promise.all([
    db.event.findFirst({ where: { id: eventId, organizationId }, select: { taxRate: true } }),
    db.registration.findMany({
      where: { eventId, event: { organizationId }, paymentStatus: "PAID" },
      select: {
        originalPrice: true, discountAmount: true, refundedAmount: true,
        pricingTier: { select: { price: true, currency: true } },
        ticketType: { select: { price: true, currency: true } },
      },
    }),
    db.crmDeal.findMany({
      where: { organizationId, eventId, status: "WON", archivedAt: null },
      select: {
        dealValue: true, currency: true,
        products: { select: { productName: true, category: true, unitPrice: true, quantity: true, currency: true, crmProduct: { select: { source: true, category: true } } } },
      },
    }),
  ]);
  return aggregateActuals({
    reportingCurrency,
    taxRatePercent: event?.taxRate ?? null,
    registrations: registrations.map((r) => ({
      basePrice: readRegistrationBasePrice(r),
      discountAmount: r.discountAmount,
      refundedAmount: r.refundedAmount,
      // Spec §6b: the currency comes from the tier or the ticket type, never the event.
      currency: r.pricingTier?.currency ?? r.ticketType?.currency ?? "USD",
    })),
    deals: deals.map((d) => ({
      dealValue: d.dealValue,
      currency: d.currency,
      products: d.products.map((p) => ({
        productName: p.productName,
        // The live catalogue product decides the account; a deleted one falls back to the line's snapshot and has no source.
        category: p.crmProduct?.category ?? p.category,
        source: p.crmProduct?.source ?? null,
        quantity: p.quantity,
        unitPrice: p.unitPrice,
        currency: p.currency,
      })),
    })),
  });
}

export interface BudgetRevenueView {
  lines: RevenueLineView[];
  categories: { id: string; code: string; name: string; isActive: boolean }[];
  /** One row per income account that has a plan or an actual, in account order. */
  accounts: { code: string; name: string; planned: string; actual: string }[];
  actuals: RevenueActuals;
  margin: MarginView;
  reportingCurrency: string;
  targetMarginPercent: string | null;
}

export async function getBudgetRevenue(organizationId: string, budgetId: string): Promise<RevenueResult<BudgetRevenueView>> {
  const b = await db.eventBudget.findFirst({
    where: { id: budgetId, organizationId },
    select: { id: true, eventId: true, reportingCurrency: true, plannedExpenseTotal: true, contingencyAmount: true, forecastTotal: true, targetMarginPercent: true },
  });
  if (!b) return fail("BUDGET_NOT_FOUND", "The budget was not found.", { budgetId });
  const [categories, lines, actuals] = await Promise.all([
    ensureRevenueCategories(organizationId),
    db.budgetRevenueLine.findMany({ where: { budgetId: b.id, organizationId }, select: REVENUE_LINE_SELECT, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    readRevenueActuals(organizationId, b.eventId, b.reportingCurrency),
  ]);
  const plannedByAccount: Record<string, ReturnType<typeof money>> = {};
  for (const l of lines) plannedByAccount[l.category.code] = (plannedByAccount[l.category.code] ?? money(0)).plus(money(l.planned));
  const nameByCode = new Map(categories.map((c) => [c.code, c.name]));
  const codes = [...new Set([...Object.keys(plannedByAccount), ...Object.keys(actuals.byAccount)])].sort();
  return {
    ok: true,
    value: {
      lines: lines.map(toRevenueLineView),
      categories: categories.map(({ id, code, name, isActive }) => ({ id, code, name, isActive })),
      accounts: codes.map((code) => ({
        code,
        name: nameByCode.get(code) ?? code,
        planned: storedString(plannedByAccount[code] ?? 0),
        actual: actuals.byAccount[code] ?? storedString(0),
      })),
      actuals,
      margin: marginView({
        plannedByAccount: Object.fromEntries(Object.entries(plannedByAccount).map(([k, v]) => [k, v.toString()])),
        actuals,
        plannedExpenseTotal: b.plannedExpenseTotal,
        contingencyAmount: b.contingencyAmount,
        forecastExpenseTotal: b.forecastTotal,
        targetMarginPercent: b.targetMarginPercent,
      }),
      reportingCurrency: b.reportingCurrency,
      targetMarginPercent: b.targetMarginPercent === null ? null : money(b.targetMarginPercent).toString(),
    },
  };
}

/** Keep the budget's planned revenue total equal to its lines. Inside the caller's transaction. */
export async function recomputePlannedRevenue(tx: Db, budgetId: string): Promise<void> {
  const sum = await tx.budgetRevenueLine.aggregate({ where: { budgetId }, _sum: { planned: true } });
  await tx.eventBudget.update({ where: { id: budgetId }, data: { plannedRevenueTotal: storedString(sum._sum.planned ?? 0) } });
}

export interface UpsertRevenueLineInput {
  organizationId: string;
  actorUserId: string;
  source: Source;
  budgetId: string;
  lineId?: string | null;
  categoryId?: string;
  description?: string;
  qty?: MoneyInput;
  unitAmount?: MoneyInput;
  transactionCurrency?: string;
  fxRateToReporting?: MoneyInput | null;
  notes?: string | null;
}

async function draftBudget(organizationId: string, budgetId: string, ctx: Record<string, unknown>) {
  const b = await db.eventBudget.findFirst({ where: { id: budgetId, organizationId }, select: { id: true, status: true, reportingCurrency: true } });
  if (!b) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (b.status !== "DRAFT") {
    return fail("INVALID_STATUS", "Planned revenue changes on a draft version only, like planned expense. Create a new version to revise it.", ctx);
  }
  return { ok: true as const, value: b };
}

export async function upsertRevenueLine(input: UpsertRevenueLineInput): Promise<RevenueResult<RevenueLineView>> {
  const ctx = { budgetId: input.budgetId, lineId: input.lineId ?? null, userId: input.actorUserId };
  const budget = await draftBudget(input.organizationId, input.budgetId, ctx);
  if (!budget.ok) return budget;
  const b = budget.value;
  const existing = input.lineId
    ? await db.budgetRevenueLine.findFirst({ where: { id: input.lineId, budgetId: b.id, organizationId: input.organizationId }, select: REVENUE_LINE_SELECT })
    : null;
  if (input.lineId && !existing) return fail("LINE_NOT_FOUND", "The revenue line was not found.", ctx);

  const categoryId = input.categoryId ?? existing?.categoryId;
  if (!categoryId) return fail("CATEGORY_NOT_FOUND", "A revenue line needs an income account.", ctx);
  if (categoryId !== existing?.categoryId) {
    const cat = await db.budgetCategory.findFirst({ where: { id: categoryId, organizationId: input.organizationId, isActive: true, type: "REVENUE" }, select: { id: true } });
    if (!cat) return fail("CATEGORY_NOT_FOUND", "The income account was not found or is archived.", ctx);
  }
  const description = (input.description ?? existing?.description ?? "").trim();
  if (!description) return fail("INVALID_AMOUNT", "A revenue line needs a description.", ctx);

  const currency = input.transactionCurrency ?? existing?.transactionCurrency ?? b.reportingCurrency;
  let rate: MoneyInput = 1;
  if (currency !== b.reportingCurrency) {
    const given = input.fxRateToReporting ?? (existing?.transactionCurrency === currency ? existing.fxRateToReporting : null);
    if (given === null || given === undefined || money(given).lte(0)) {
      return fail("RATE_REQUIRED", `A ${currency} line needs its exchange rate to ${b.reportingCurrency} (spec §7).`, ctx);
    }
    rate = given;
  }
  let planned;
  try {
    planned = lineTotals({ qty: input.qty ?? existing?.qty ?? 1, unitCost: input.unitAmount ?? existing?.unitAmount ?? 0, fxRateToReporting: rate, taxRatePercent: null }).planned;
  } catch (err) {
    return fail("INVALID_AMOUNT", (err as Error).message, ctx);
  }
  const data = {
    categoryId,
    description,
    qty: storedString(input.qty ?? existing?.qty ?? 1),
    unitAmount: storedString(input.unitAmount ?? existing?.unitAmount ?? 0),
    transactionCurrency: currency,
    fxRateToReporting: money(rate).toString(),
    fxRateSource: currency === b.reportingCurrency ? "same-currency" : "manual",
    fxRateAsOf: currency === b.reportingCurrency ? null : new Date(),
    planned: storedString(planned),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
  try {
    const id = await tenantTransaction(async (tx) => {
      let lineId: string;
      if (existing) {
        await tx.budgetRevenueLine.update({ where: { id: existing.id }, data });
        lineId = existing.id;
      } else {
        const last = await tx.budgetRevenueLine.aggregate({ where: { budgetId: b.id }, _max: { sortOrder: true } });
        const created = await tx.budgetRevenueLine.create({
          data: { organizationId: input.organizationId, budgetId: b.id, lineKey: globalThis.crypto.randomUUID(), sortOrder: (last._max.sortOrder ?? -1) + 1, ...data },
          select: { id: true },
        });
        lineId = created.id;
      }
      await recomputePlannedRevenue(tx, b.id);
      await tx.eventBudget.update({ where: { id: b.id }, data: { version: { increment: 1 } } });
      await tx.auditLog
        .create({
          data: {
            userId: input.actorUserId, organizationId: input.organizationId, action: existing ? "UPDATE" : "CREATE", entityType: "BudgetRevenueLine", entityId: lineId,
            changes: { source: input.source, budgetId: b.id, description, planned: storedString(planned), currency },
          },
        })
        .catch((err) => apiLogger.error({ msg: "procurement/revenue:audit-failed", err }));
      return lineId;
    });
    const row = await db.budgetRevenueLine.findFirst({ where: { id, organizationId: input.organizationId }, select: REVENUE_LINE_SELECT });
    if (!row) return fail("LINE_NOT_FOUND", "The revenue line was not found.", ctx);
    return { ok: true, value: toRevenueLineView(row) };
  } catch (err) {
    apiLogger.error({ msg: "procurement/revenue:upsert-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not save the revenue line.", ctx);
  }
}

export async function deleteRevenueLine(input: { organizationId: string; actorUserId: string; source: Source; budgetId: string; lineId: string }): Promise<RevenueResult<{ id: string }>> {
  const ctx = { budgetId: input.budgetId, lineId: input.lineId, userId: input.actorUserId };
  const budget = await draftBudget(input.organizationId, input.budgetId, ctx);
  if (!budget.ok) return budget;
  const line = await db.budgetRevenueLine.findFirst({ where: { id: input.lineId, budgetId: input.budgetId, organizationId: input.organizationId }, select: { id: true, description: true } });
  if (!line) return fail("LINE_NOT_FOUND", "The revenue line was not found.", ctx);
  try {
    await tenantTransaction(async (tx) => {
      // Nothing points at a revenue line, so a removal is a real delete (expense lines are soft-deleted for their commitments).
      await tx.budgetRevenueLine.delete({ where: { id: line.id } });
      await recomputePlannedRevenue(tx, input.budgetId);
      await tx.eventBudget.update({ where: { id: input.budgetId }, data: { version: { increment: 1 } } });
      await tx.auditLog
        .create({ data: { userId: input.actorUserId, organizationId: input.organizationId, action: "DELETE", entityType: "BudgetRevenueLine", entityId: line.id, changes: { source: input.source, budgetId: input.budgetId, description: line.description } } })
        .catch((err) => apiLogger.error({ msg: "procurement/revenue:audit-failed", err }));
    });
    return { ok: true, value: { id: line.id } };
  } catch (err) {
    apiLogger.error({ msg: "procurement/revenue:delete-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not remove the revenue line.", ctx);
  }
}

/** Copy a version's revenue lines onto the new version with the same line keys. Inside the clone's transaction. */
export async function cloneRevenueLines(tx: Db, input: { organizationId: string; fromBudgetId: string; toBudgetId: string }): Promise<number> {
  const lines = await tx.budgetRevenueLine.findMany({ where: { budgetId: input.fromBudgetId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  if (lines.length === 0) return 0;
  await tx.budgetRevenueLine.createMany({
    data: lines.map((l) => ({
      organizationId: input.organizationId, budgetId: input.toBudgetId, lineKey: l.lineKey, categoryId: l.categoryId, description: l.description,
      qty: l.qty, unitAmount: l.unitAmount, transactionCurrency: l.transactionCurrency, fxRateToReporting: l.fxRateToReporting,
      fxRateSource: l.fxRateSource, fxRateAsOf: l.fxRateAsOf, planned: l.planned, notes: l.notes, sortOrder: l.sortOrder,
    })),
  });
  await recomputePlannedRevenue(tx, input.toBudgetId);
  return lines.length;
}
