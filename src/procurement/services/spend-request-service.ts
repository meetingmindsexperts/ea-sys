/**
 * Spend requests (spec §5, §6, §8): a requester drafts one against an active
 * or frozen budget's line with quotes, submits it, and the submit runs the
 * budget check at once and routes the request on the AED matrix through the
 * approvals primitive under the SPEND_REQUEST subject. Within the line's
 * remaining it goes to whoever the amount requires; over it, it is never
 * silently allowed: it is marked OVER_BUDGET (FROZEN on a frozen budget,
 * with a reason demanded) and routed to the final approver only. Approval
 * lands it APPROVED, or AWAITING_SUPPLIER while its supplier is not yet
 * approved; a rise in an approved amount is routed on the new total and
 * approved for the difference; a fall applies at once. An approval whose
 * supplier is approved issues the purchase order inside the same
 * transaction (commitment-service), so approval and order commit together.
 *
 * ONE implementation for the routes, the pages and, later, the MCP tools.
 * Errors as values (src/services/README.md). Runs inside the caller's tenant
 * lane; it never opens one itself. Every mutating write is conditional on
 * the version it read, and every transition writes an AuditLog row with
 * `source`.
 */
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { Prisma } from "@prisma/client";
import { cancelPendingApprovals, createApprovalRequest, decideApprovalRequest, resolveApprover, type Db } from "@/lib/approvals/approvals-service";
import type { ProcurementUserLike } from "@/lib/procurement-visibility";
import { nextDocumentNumber } from "../lib/document-numbers";
import { afterOrderIssued, COMMITMENT_SELECT, issueOrderInTx, toCommitmentView, type CommitmentView } from "./commitment-service";
import { FULFILLMENT_LABEL, type FulfillmentStatusValue } from "../lib/commitment-rules";
import { AED_PEG_RATES, FLOATING_TO_AED_BAND, money, resolveReportingToAedRate, storedString, toAed, toStored, type MoneyInput, type RateResolution } from "../lib/money";
import {
  amendmentEffect,
  budgetAcceptsRequests,
  budgetCheck,
  FLOATING_PAIR_BAND,
  missingForSubmission,
  OPEN_REQUEST_STATUSES,
  resolveRequestToReportingRate,
  SPEND_REQUEST_STATUS_LABEL,
  toReporting,
  type BudgetCheckOutcome,
  type SpendRequestStatusValue,
} from "../lib/spend-request-rules";

export type SpendRequestErrorCode =
  | "REQUEST_NOT_FOUND"
  | "BUDGET_NOT_FOUND"
  | "LINE_NOT_FOUND"
  | "SUPPLIER_NOT_FOUND"
  | "QUOTE_NOT_FOUND"
  | "BUDGET_NOT_ACTIVE"
  | "INVALID_STATUS"
  | "NOT_REQUESTER"
  | "FINAL_APPROVER_CANNOT_REQUEST"
  | "STALE_WRITE"
  | "RATE_REQUIRED"
  | "INVALID_AMOUNT"
  | "INCOMPLETE"
  | "REASON_REQUIRED"
  | "NO_APPROVER"
  | "APPROVAL_FAILED"
  | "INVALID_FILTER"
  | "UNKNOWN";

export type SpendRequestRefusal = { ok: false; code: SpendRequestErrorCode; message: string; meta?: Record<string, unknown> };
export type SpendRequestResult<T> = { ok: true; request: T } | SpendRequestRefusal;

type Source = "ui" | "mcp";
/** Who is acting: the routes pass the session id and whether the person administers the module. */
export interface Actor {
  id: string;
  isAdmin: boolean;
}

export const QUOTE_SELECT = {
  id: true, vendorName: true, supplierId: true, amount: true, taxAmount: true, currency: true, quotedOn: true, validUntil: true, recommended: true, notes: true, mediaFileId: true,
  fileUrl: true, fileName: true, fileMimeType: true, fileSize: true, createdAt: true,
  supplier: { select: { id: true, code: true, displayName: true, approvalStatus: true } },
} as const;

export const SPEND_REQUEST_SELECT = {
  id: true, organizationId: true, requestNo: true, budgetId: true, lineKey: true, eventCode: true, requesterUserId: true, supplierId: true, proposedVendorName: true,
  title: true, justification: true, amount: true, taxAmount: true, currency: true, fxRateToReporting: true, amountAed: true, categoryId: true, neededBy: true,
  sourcingMethod: true, budgetCheckStatus: true, status: true, priority: true, linkedCommitmentId: true, emailSupplierOnIssue: true, approvalRequestId: true, submittedAt: true, decidedAt: true,
  decidedByUserId: true, decisionNote: true, cancelledAt: true, cancelReason: true, version: true, createdAt: true, updatedAt: true,
  budget: { select: { id: true, eventCode: true, versionNo: true, status: true, reportingCurrency: true, event: { select: { name: true } } } },
  supplier: { select: { id: true, code: true, displayName: true, approvalStatus: true, isActive: true } },
  category: { select: { id: true, code: true, name: true } },
  quotes: { select: QUOTE_SELECT, orderBy: { createdAt: "asc" } },
} as const;

type Row = Prisma.SpendRequestGetPayload<{ select: typeof SPEND_REQUEST_SELECT }>;
type QuoteRow = Prisma.SpendRequestQuoteGetPayload<{ select: typeof QUOTE_SELECT }>;

const LINE_SELECT = {
  id: true, lineKey: true, description: true, planned: true, committedOpen: true, actual: true, categoryId: true, isContingency: true,
  category: { select: { id: true, code: true, name: true } },
} as const;
type LineRow = Prisma.BudgetLineGetPayload<{ select: typeof LINE_SELECT }>;

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const s4 = (v: MoneyInput | null | undefined) => (v === null || v === undefined ? null : storedString(v));
/** A YYYY-MM-DD string as the UTC midnight a `@db.Date` column stores. */
const toDay = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00.000Z`) : null);

export function toQuoteView(q: QuoteRow) {
  return { ...q, amount: storedString(q.amount), taxAmount: storedString(q.taxAmount), quotedOn: day(q.quotedOn), validUntil: day(q.validUntil) };
}
export type SpendRequestQuoteView = ReturnType<typeof toQuoteView>;

export function toSpendRequestView(r: Row) {
  const rate = r.fxRateToReporting === null ? null : money(r.fxRateToReporting);
  return {
    ...r,
    amount: storedString(r.amount),
    taxAmount: storedString(r.taxAmount),
    fxRateToReporting: rate === null ? null : rate.toString(),
    /** The ex-VAT amount in the budget's reporting currency, the figure the budget check reads. */
    amountReporting: rate === null ? null : storedString(toReporting(r.amount, rate)),
    amountAed: s4(r.amountAed),
    neededBy: day(r.neededBy),
    statusLabel: SPEND_REQUEST_STATUS_LABEL[r.status as SpendRequestStatusValue] ?? r.status,
    quotes: r.quotes.map(toQuoteView),
  };
}
export type SpendRequestView = ReturnType<typeof toSpendRequestView>;

export function toLineView(l: LineRow) {
  return {
    lineKey: l.lineKey,
    description: l.description,
    planned: storedString(l.planned),
    committedOpen: storedString(l.committedOpen),
    actual: storedString(l.actual),
    remaining: storedString(money(l.planned).minus(money(l.committedOpen)).minus(money(l.actual))),
    isContingency: l.isContingency,
    category: l.category,
  };
}
export type SpendRequestLineView = ReturnType<typeof toLineView>;

/** What the approval carries so the decision can apply it from the row alone. */
export type SubmissionPayload = {
  kind: "SUBMISSION";
  budgetId: string;
  lineKey: string;
  budgetCheck: BudgetCheckOutcome["status"];
  amountReporting: string;
  remainingBefore: string;
  remainingAfter: string;
  reportingCurrency: string;
  requestToReportingRate: string;
  reportingToAedRate: string;
  rateSource: string;
};
export type AmendmentPayload = {
  kind: "AMENDMENT";
  budgetId: string;
  lineKey: string;
  /** The status to return to when the delta is decided either way. */
  resumeStatus: "APPROVED" | "AWAITING_SUPPLIER";
  previousAmount: string;
  nextAmount: string;
  nextTaxAmount: string;
  nextAmountAed: string;
  deltaReporting: string;
  budgetCheck: BudgetCheckOutcome["status"];
  reason: string;
  reportingToAedRate: string;
  rateSource: string;
};
export type SpendRequestApprovalPayload = SubmissionPayload | AmendmentPayload;
export function readApprovalPayload(payload: unknown): SpendRequestApprovalPayload | null {
  const p = payload as Partial<SpendRequestApprovalPayload> | null;
  if (!p || typeof p !== "object") return null;
  if (p.kind === "SUBMISSION" || p.kind === "AMENDMENT") return p as SpendRequestApprovalPayload;
  return null;
}

function fail(code: SpendRequestErrorCode, message: string, ctx: Record<string, unknown> = {}, meta?: Record<string, unknown>): SpendRequestRefusal {
  apiLogger.warn({ msg: "procurement/requests:rejected", code, ...ctx });
  return { ok: false, code, message, ...(meta ? { meta } : {}) };
}

async function audit(client: Db, data: { userId: string; organizationId: string; action: string; entityId: string; changes: Prisma.InputJsonValue }) {
  await client.auditLog
    .create({ data: { ...data, entityType: "SpendRequest" } })
    .catch((err) => apiLogger.error({ msg: "procurement/requests:audit-failed", err, action: data.action }));
}

async function loadRequest(client: Db, organizationId: string, requestId: string) {
  return client.spendRequest.findFirst({ where: { id: requestId, organizationId }, select: SPEND_REQUEST_SELECT });
}
async function loadLine(client: Db, budgetId: string, lineKey: string) {
  return client.budgetLine.findFirst({ where: { budgetId, lineKey, deletedAt: null }, select: LINE_SELECT });
}
/** Spec §8.8: the final approver never requests, so requester != approver can never leave a request with nobody to decide it. Read from the row, not the session. */
async function isFinalApprover(client: Db, organizationId: string, userId: string): Promise<boolean> {
  const row = await client.user.findFirst({ where: { id: userId, organizationId }, select: { procurementApproveUnlimited: true } });
  return row?.procurementApproveUnlimited === true;
}
/** Why the request's own rate was refused, with the band it must sit in (a rail, not a price). */
function requestRateRefusal(requestCurrency: string, reportingCurrency: string, reason: "missing" | "invalid" | "out-of-band"): string {
  const req = requestCurrency.toUpperCase();
  const rep = reportingCurrency.toUpperCase();
  if (reason === "missing") return `Give the ${req} to ${rep} rate.`;
  if (reason === "invalid") return `The ${req} to ${rep} rate must be greater than zero.`;
  const floatingPair = !(req in AED_PEG_RATES) && !(rep in AED_PEG_RATES);
  return floatingPair
    ? `The ${req} to ${rep} rate must sit between ${FLOATING_PAIR_BAND.min} and ${FLOATING_PAIR_BAND.max}.`
    : `That ${req} to ${rep} rate implies a rate to AED outside ${FLOATING_TO_AED_BAND.min} to ${FLOATING_TO_AED_BAND.max}; check the figure.`;
}
function rateRefusal(reportingCurrency: string, r: Extract<RateResolution, { ok: false }>): string {
  return r.reason === "missing"
    ? `${reportingCurrency} has no fixed rate to AED: give the rate to route the approval (spec §7.3).`
    : `The ${reportingCurrency} to AED rate must sit between ${FLOATING_TO_AED_BAND.min} and ${FLOATING_TO_AED_BAND.max}.`;
}

// ── reads ────────────────────────────────────────────────────────────────────

const STATUS_FILTERS = new Set<string>(Object.keys(SPEND_REQUEST_STATUS_LABEL));
export function invalidSpendRequestStatusFilter(status: string | undefined): boolean {
  return status !== undefined && !STATUS_FILTERS.has(status);
}

export async function listSpendRequests(organizationId: string, filter: { status?: string; budgetId?: string; requesterUserId?: string } = {}) {
  const rows = await db.spendRequest.findMany({
    where: {
      organizationId,
      ...(filter.status ? { status: filter.status as SpendRequestStatusValue } : {}),
      ...(filter.budgetId ? { budgetId: filter.budgetId } : {}),
      ...(filter.requesterUserId ? { requesterUserId: filter.requesterUserId } : {}),
    },
    select: SPEND_REQUEST_SELECT,
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const orderIds = rows.map((r) => r.linkedCommitmentId).filter((id): id is string => !!id);
  const [names, orders] = await Promise.all([
    userNames(db, organizationId, rows.map((r) => r.requesterUserId)),
    orderIds.length === 0
      ? Promise.resolve([])
      : db.commitment.findMany({ where: { id: { in: orderIds }, organizationId }, select: { id: true, commitmentNo: true, status: true, fulfillmentStatus: true, sentToSupplierAt: true, receiptConfirmedAt: true } }),
  ]);
  const orderById = new Map(orders.map((o) => [o.id, { ...o, fulfillmentLabel: FULFILLMENT_LABEL[o.fulfillmentStatus as FulfillmentStatusValue] ?? o.fulfillmentStatus }]));
  return rows.map((r) => ({ ...toSpendRequestView(r), requesterName: names.get(r.requesterUserId) ?? null, order: r.linkedCommitmentId ? (orderById.get(r.linkedCommitmentId) ?? null) : null }));
}

async function userNames(client: Db, organizationId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const users = await client.user.findMany({ where: { id: { in: unique }, organizationId }, select: { id: true, firstName: true, lastName: true } });
  return new Map(users.map((u) => [u.id, `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim()]));
}

export type SpendRequestDetail = SpendRequestView & {
  requesterName: string | null;
  decidedByName: string | null;
  line: SpendRequestLineView | null;
  /** The purchase order this request became (slice 3); null until approval issues it, and again after a cancel. */
  order: CommitmentView | null;
  approvals: {
    id: string;
    status: string;
    amountAed: string;
    payload: SpendRequestApprovalPayload | null;
    createdAt: Date;
    decidedAt: Date | null;
    steps: { assigneeUserId: string; assigneeName: string | null; status: string; decidedByUserId: string | null; decidedByName: string | null; decidedAt: Date | null; note: string | null; dueAt: Date }[];
  }[];
};

export async function getSpendRequest(organizationId: string, requestId: string): Promise<SpendRequestResult<SpendRequestDetail>> {
  const r = await loadRequest(db, organizationId, requestId);
  if (!r) return fail("REQUEST_NOT_FOUND", "The spend request was not found.", { requestId });
  const [line, order, approvals] = await Promise.all([
    r.budgetId && r.lineKey ? loadLine(db, r.budgetId, r.lineKey) : null,
    r.linkedCommitmentId ? db.commitment.findFirst({ where: { id: r.linkedCommitmentId, organizationId }, select: COMMITMENT_SELECT }) : null,
    db.approvalRequest.findMany({
      where: { organizationId, subjectType: "SPEND_REQUEST", subjectId: r.id },
      select: { id: true, status: true, amountAed: true, payload: true, createdAt: true, decidedAt: true, steps: { select: { assigneeUserId: true, status: true, decidedByUserId: true, decidedAt: true, note: true, dueAt: true }, orderBy: { sequence: "asc" } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);
  const names = await userNames(db, organizationId, [r.requesterUserId, r.decidedByUserId ?? "", ...approvals.flatMap((a) => a.steps.flatMap((s) => [s.assigneeUserId, s.decidedByUserId ?? ""]))]);
  return {
    ok: true,
    request: {
      ...toSpendRequestView(r),
      requesterName: names.get(r.requesterUserId) ?? null,
      decidedByName: r.decidedByUserId ? (names.get(r.decidedByUserId) ?? null) : null,
      line: line ? toLineView(line) : null,
      order: order ? toCommitmentView(order) : null,
      approvals: approvals.map((a) => ({
        id: a.id,
        status: a.status,
        amountAed: storedString(a.amountAed),
        payload: readApprovalPayload(a.payload),
        createdAt: a.createdAt,
        decidedAt: a.decidedAt,
        steps: a.steps.map((s) => ({ ...s, assigneeName: names.get(s.assigneeUserId) ?? null, decidedByName: s.decidedByUserId ? (names.get(s.decidedByUserId) ?? null) : null })),
      })),
    },
  };
}

// ── the side panel ───────────────────────────────────────────────────────────

export interface PreviewBudgetCheckInput {
  organizationId: string;
  actorUserId: string;
  budgetId: string;
  lineKey: string;
  amount: MoneyInput;
  currency: string;
  fxRateToReporting?: MoneyInput | null;
  reportingToAedRate?: MoneyInput | null;
  excludeRequestId?: string | null;
}
export type BudgetCheckPreview = {
  budget: { id: string; eventCode: string; versionNo: number; status: string; reportingCurrency: string };
  line: SpendRequestLineView;
  requestToReportingRate: string;
  rateSource: "same" | "peg" | "caller";
  check: { status: BudgetCheckOutcome["status"]; exception: boolean; reasonRequired: boolean; amountReporting: string; remainingBefore: string; remainingAfter: string };
  /** Null when the reporting currency floats and no rate was given: the ceiling cannot be judged yet. */
  amountAed: string | null;
  route: { ok: true; approverUserId: string; approverName: string | null; exception: boolean } | { ok: false; code: "NO_APPROVER" | "RATE_REQUIRED"; message: string };
  /** Requests already raised on this line and still open; informational, never counted in the stored figures. */
  openRequests: { id: string; requestNo: string; title: string; status: string; amountReporting: string | null }[];
};

/** What the form's side panel shows while the requester types: the same check and the same routing the submit will run. */
export async function previewBudgetCheck(input: PreviewBudgetCheckInput): Promise<SpendRequestResult<BudgetCheckPreview>> {
  const ctx = { budgetId: input.budgetId, lineKey: input.lineKey, userId: input.actorUserId };
  const budget = await db.eventBudget.findFirst({ where: { id: input.budgetId, organizationId: input.organizationId }, select: { id: true, eventCode: true, versionNo: true, status: true, reportingCurrency: true } });
  if (!budget) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (!budgetAcceptsRequests(budget.status)) return fail("BUDGET_NOT_ACTIVE", `Only an active or frozen budget takes a spend request; this version is ${budget.status.toLowerCase().replace("_", " ")}.`, ctx, { status: budget.status });
  const line = await loadLine(db, budget.id, input.lineKey);
  if (!line) return fail("LINE_NOT_FOUND", "That line is not on this budget version.", ctx);
  const rate = resolveRequestToReportingRate(input.currency, budget.reportingCurrency, input.fxRateToReporting);
  if (!rate.ok) return fail("RATE_REQUIRED", requestRateRefusal(input.currency, budget.reportingCurrency, rate.reason), ctx, { reason: rate.reason });
  const amountReporting = toReporting(input.amount, rate.rate);
  const check = budgetCheck({ budgetStatus: budget.status, line, amountReporting });
  const open = await db.spendRequest.findMany({
    where: { organizationId: input.organizationId, budgetId: budget.id, lineKey: line.lineKey, status: { in: [...OPEN_REQUEST_STATUSES] }, ...(input.excludeRequestId ? { id: { not: input.excludeRequestId } } : {}) },
    select: { id: true, requestNo: true, title: true, status: true, amount: true, fxRateToReporting: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const aed = resolveReportingToAedRate(budget.reportingCurrency, input.reportingToAedRate);
  let amountAed: string | null = null;
  let route: BudgetCheckPreview["route"];
  if (!aed.ok) {
    route = { ok: false, code: "RATE_REQUIRED", message: rateRefusal(budget.reportingCurrency, aed) };
  } else {
    const aedAmount = toAed(amountReporting, aed.rate);
    amountAed = storedString(aedAmount);
    const r = await resolveApprover(db, { organizationId: input.organizationId, subjectType: "SPEND_REQUEST", amountAed: Number(aedAmount.toString()), requesterUserId: input.actorUserId, requireFinalApprover: check.exception });
    if (!r.ok) route = { ok: false, code: "NO_APPROVER", message: r.message };
    else {
      const names = await userNames(db, input.organizationId, [r.approverUserId]);
      route = { ok: true, approverUserId: r.approverUserId, approverName: names.get(r.approverUserId) ?? null, exception: check.exception };
    }
  }
  return {
    ok: true,
    request: {
      budget,
      line: toLineView(line),
      requestToReportingRate: rate.rate.toString(),
      rateSource: rate.source,
      check: { status: check.status, exception: check.exception, reasonRequired: check.reasonRequired, amountReporting: storedString(check.amountReporting), remainingBefore: storedString(check.remainingBefore), remainingAfter: storedString(check.remainingAfter) },
      amountAed,
      route,
      openRequests: open.map((o) => ({ id: o.id, requestNo: o.requestNo, title: o.title, status: o.status, amountReporting: o.fxRateToReporting === null ? null : storedString(toReporting(o.amount, o.fxRateToReporting)) })),
    },
  };
}

// ── create and edit a draft ──────────────────────────────────────────────────

export interface SpendRequestFields {
  budgetId: string;
  lineKey?: string | null;
  title: string;
  justification?: string | null;
  amount: MoneyInput;
  taxAmount?: MoneyInput | null;
  currency: string;
  fxRateToReporting?: MoneyInput | null;
  supplierId?: string | null;
  proposedVendorName?: string | null;
  categoryId?: string | null;
  neededBy?: string | null;
  sourcingMethod?: "SINGLE_QUOTE" | "COMPETITIVE_QUOTES" | "EXISTING_CONTRACT" | "SOLE_SOURCE" | null;
  priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  /** Email the purchase order PDF to the supplier the moment it is issued (the requester's choice, default off). */
  emailSupplierOnIssue?: boolean;
}
export interface CreateSpendRequestInput extends SpendRequestFields {
  organizationId: string;
  actor: Actor;
  source: Source;
}

/** The checks a draft's budget, line, supplier and rate must pass, shared by create and edit. */
async function resolveDraftRefs(client: Db, organizationId: string, f: { budgetId: string; lineKey?: string | null; supplierId?: string | null; currency: string; fxRateToReporting?: MoneyInput | null; categoryId?: string | null }, ctx: Record<string, unknown>) {
  const budget = await client.eventBudget.findFirst({ where: { id: f.budgetId, organizationId }, select: { id: true, eventCode: true, status: true, reportingCurrency: true } });
  if (!budget) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (!budgetAcceptsRequests(budget.status)) return fail("BUDGET_NOT_ACTIVE", `Only an active or frozen budget takes a spend request; this version is ${budget.status.toLowerCase().replace("_", " ")}.`, ctx, { status: budget.status });
  const line = f.lineKey ? await loadLine(client, budget.id, f.lineKey) : null;
  if (f.lineKey && !line) return fail("LINE_NOT_FOUND", "That line is not on this budget version.", ctx);
  if (f.supplierId) {
    const supplier = await client.supplier.findFirst({ where: { id: f.supplierId, organizationId }, select: { id: true } });
    if (!supplier) return fail("SUPPLIER_NOT_FOUND", "The supplier was not found.", ctx);
  }
  const rate = resolveRequestToReportingRate(f.currency, budget.reportingCurrency, f.fxRateToReporting);
  if (!rate.ok) return fail("RATE_REQUIRED", requestRateRefusal(f.currency, budget.reportingCurrency, rate.reason), ctx, { reason: rate.reason });
  const categoryId = f.categoryId ?? line?.categoryId ?? null;
  if (categoryId) {
    const category = await client.budgetCategory.findFirst({ where: { id: categoryId, organizationId }, select: { id: true } });
    if (!category) return fail("LINE_NOT_FOUND", "The category was not found.", ctx);
  }
  return { ok: true as const, budget, line, rate: rate.rate, categoryId };
}

export async function createSpendRequest(input: CreateSpendRequestInput): Promise<SpendRequestResult<SpendRequestDetail>> {
  const ctx = { organizationId: input.organizationId, userId: input.actor.id, budgetId: input.budgetId };
  if (await isFinalApprover(db, input.organizationId, input.actor.id)) {
    return fail("FINAL_APPROVER_CANNOT_REQUEST", "The final approver never raises a request (spec §8.8): ask a colleague holding the request grant to raise it.", ctx);
  }
  const refs = await resolveDraftRefs(db, input.organizationId, input, ctx);
  if (!refs.ok) return refs;
  if (money(input.amount).lte(0)) return fail("INVALID_AMOUNT", "The amount must be greater than zero.", ctx);
  try {
    const id = await tenantTransaction(async (tx) => {
      const requestNo = await nextDocumentNumber(tx, "PR", input.organizationId);
      const created = await tx.spendRequest.create({
        data: {
          organizationId: input.organizationId,
          requestNo,
          budgetId: refs.budget.id,
          lineKey: refs.line?.lineKey ?? null,
          eventCode: refs.budget.eventCode,
          requesterUserId: input.actor.id,
          supplierId: input.supplierId ?? null,
          proposedVendorName: input.proposedVendorName?.trim() || null,
          title: input.title.trim(),
          justification: input.justification?.trim() || null,
          amount: storedString(input.amount),
          taxAmount: storedString(input.taxAmount ?? 0),
          currency: input.currency.toUpperCase(),
          fxRateToReporting: refs.rate.toString(),
          categoryId: refs.categoryId,
          neededBy: toDay(input.neededBy),
          sourcingMethod: input.sourcingMethod ?? null,
          priority: input.priority ?? "NORMAL",
          emailSupplierOnIssue: input.emailSupplierOnIssue === true,
        },
        select: { id: true },
      });
      await audit(tx, { userId: input.actor.id, organizationId: input.organizationId, action: "CREATE", entityId: created.id, changes: { source: input.source, requestNo, budgetId: refs.budget.id, lineKey: refs.line?.lineKey ?? null, amount: storedString(input.amount), currency: input.currency.toUpperCase() } });
      return created.id;
    });
    apiLogger.info({ msg: "procurement/requests:created", requestId: id, ...ctx });
    return getSpendRequest(input.organizationId, id);
  } catch (err) {
    apiLogger.error({ msg: "procurement/requests:create-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not create the spend request.", ctx);
  }
}

export interface UpdateSpendRequestInput extends Partial<SpendRequestFields> {
  organizationId: string;
  actor: Actor;
  source: Source;
  requestId: string;
  expectedVersion: number;
}

/** A draft is edited by its requester (or an admin); anything past draft is withdrawn first. */
export async function updateSpendRequest(input: UpdateSpendRequestInput): Promise<SpendRequestResult<SpendRequestDetail>> {
  const ctx = { requestId: input.requestId, userId: input.actor.id };
  const r = await loadRequest(db, input.organizationId, input.requestId);
  if (!r) return fail("REQUEST_NOT_FOUND", "The spend request was not found.", ctx);
  if (r.status !== "DRAFT") return fail("INVALID_STATUS", "Only a draft can be edited; withdraw it first.", ctx, { status: r.status });
  if (r.requesterUserId !== input.actor.id && !input.actor.isAdmin) return fail("NOT_REQUESTER", "Only the person who raised this request can edit it.", ctx);
  const merged = {
    budgetId: input.budgetId ?? r.budgetId ?? "",
    lineKey: input.lineKey !== undefined ? input.lineKey : r.lineKey,
    supplierId: input.supplierId !== undefined ? input.supplierId : r.supplierId,
    currency: input.currency ?? r.currency,
    fxRateToReporting: input.fxRateToReporting !== undefined ? input.fxRateToReporting : r.fxRateToReporting === null ? null : money(r.fxRateToReporting),
    categoryId: input.categoryId !== undefined ? input.categoryId : r.categoryId,
  };
  const refs = await resolveDraftRefs(db, input.organizationId, merged, ctx);
  if (!refs.ok) return refs;
  const amount = input.amount ?? r.amount;
  if (money(amount).lte(0)) return fail("INVALID_AMOUNT", "The amount must be greater than zero.", ctx);
  const data: Prisma.SpendRequestUncheckedUpdateManyInput = {
    budgetId: refs.budget.id,
    eventCode: refs.budget.eventCode,
    lineKey: refs.line?.lineKey ?? null,
    supplierId: merged.supplierId ?? null,
    currency: merged.currency.toUpperCase(),
    fxRateToReporting: refs.rate.toString(),
    categoryId: refs.categoryId,
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    ...(input.justification !== undefined ? { justification: input.justification?.trim() || null } : {}),
    ...(input.amount !== undefined ? { amount: storedString(input.amount) } : {}),
    ...(input.taxAmount !== undefined ? { taxAmount: storedString(input.taxAmount ?? 0) } : {}),
    ...(input.proposedVendorName !== undefined ? { proposedVendorName: input.proposedVendorName?.trim() || null } : {}),
    ...(input.neededBy !== undefined ? { neededBy: toDay(input.neededBy) } : {}),
    ...(input.sourcingMethod !== undefined ? { sourcingMethod: input.sourcingMethod } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.emailSupplierOnIssue !== undefined ? { emailSupplierOnIssue: input.emailSupplierOnIssue } : {}),
  };
  try {
    const res = await db.spendRequest.updateMany({ where: { id: r.id, organizationId: input.organizationId, status: "DRAFT", version: input.expectedVersion }, data: { ...data, version: { increment: 1 } } });
    if (res.count === 0) return fail("STALE_WRITE", "Someone else changed this request; reload and try again.", ctx, { currentVersion: r.version });
    await audit(db, { userId: input.actor.id, organizationId: input.organizationId, action: "UPDATE", entityId: r.id, changes: { source: input.source, requestNo: r.requestNo, budgetId: refs.budget.id, fields: Object.keys(input).filter((k) => !["organizationId", "actor", "source", "requestId", "expectedVersion"].includes(k)) } });
    return getSpendRequest(input.organizationId, r.id);
  } catch (err) {
    apiLogger.error({ msg: "procurement/requests:update-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not save the spend request.", ctx);
  }
}

// ── submit: the budget check and the routing ─────────────────────────────────

export async function submitSpendRequest(input: { organizationId: string; actor: Actor; source: Source; requestId: string; expectedVersion: number; reportingToAedRate?: MoneyInput | null }): Promise<SpendRequestResult<SpendRequestDetail>> {
  const ctx = { requestId: input.requestId, userId: input.actor.id };
  const r = await loadRequest(db, input.organizationId, input.requestId);
  if (!r) return fail("REQUEST_NOT_FOUND", "The spend request was not found.", ctx);
  if (r.status !== "DRAFT") return fail("INVALID_STATUS", "Only a draft can be submitted.", ctx, { status: r.status });
  if (r.requesterUserId !== input.actor.id) return fail("NOT_REQUESTER", "Only the person who raised this request can submit it.", ctx);
  if (await isFinalApprover(db, input.organizationId, input.actor.id)) {
    return fail("FINAL_APPROVER_CANNOT_REQUEST", "The final approver never raises a request (spec §8.8).", ctx);
  }
  const missing = missingForSubmission(r);
  if (missing.length > 0) return fail("INCOMPLETE", "The request is not complete enough to submit.", ctx, { missing });
  if (!r.budgetId || !r.lineKey) return fail("INCOMPLETE", "The request needs a budget line.", ctx, { missing: ["a budget line to request against"] });
  const budget = await db.eventBudget.findFirst({ where: { id: r.budgetId, organizationId: input.organizationId }, select: { id: true, status: true, reportingCurrency: true } });
  if (!budget) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (!budgetAcceptsRequests(budget.status)) return fail("BUDGET_NOT_ACTIVE", `Only an active or frozen budget takes a spend request; this version is ${budget.status.toLowerCase().replace("_", " ")}.`, ctx, { status: budget.status });
  const line = await loadLine(db, budget.id, r.lineKey);
  if (!line) return fail("LINE_NOT_FOUND", "That line is no longer on this budget version.", ctx);
  const rate = resolveRequestToReportingRate(r.currency, budget.reportingCurrency, r.fxRateToReporting === null ? null : money(r.fxRateToReporting));
  if (!rate.ok) return fail("RATE_REQUIRED", requestRateRefusal(r.currency, budget.reportingCurrency, rate.reason), ctx, { reason: rate.reason });
  const amountReporting = toReporting(r.amount, rate.rate);
  const check = budgetCheck({ budgetStatus: budget.status, line, amountReporting });
  if (check.reasonRequired && !r.justification) {
    return fail("REASON_REQUIRED", "This request is over the line's remaining on a frozen budget: give the reason before it goes to the final approver (spec §8.5).", ctx, { budgetCheck: check.status });
  }
  const aed = resolveReportingToAedRate(budget.reportingCurrency, input.reportingToAedRate);
  if (!aed.ok) return fail("RATE_REQUIRED", rateRefusal(budget.reportingCurrency, aed), ctx, { reason: aed.reason });
  const amountAed = toAed(amountReporting, aed.rate);
  const payload: SubmissionPayload = {
    kind: "SUBMISSION",
    budgetId: budget.id,
    lineKey: line.lineKey,
    budgetCheck: check.status,
    amountReporting: storedString(amountReporting),
    remainingBefore: storedString(check.remainingBefore),
    remainingAfter: storedString(check.remainingAfter),
    reportingCurrency: budget.reportingCurrency,
    requestToReportingRate: rate.rate.toString(),
    reportingToAedRate: aed.rate.toString(),
    rateSource: aed.source,
  };
  try {
    const outcome = await tenantTransaction(async (tx) => {
      const req = await createApprovalRequest(tx, {
        organizationId: input.organizationId,
        subjectType: "SPEND_REQUEST",
        subjectId: r.id,
        amountAed: Number(amountAed.toString()),
        amount: storedString(r.amount),
        currency: r.currency,
        requesterUserId: input.actor.id,
        reason: r.justification,
        payload,
        requireFinalApprover: check.exception,
        source: input.source,
      });
      if (!req.ok) return req;
      const res = await tx.spendRequest.updateMany({
        where: { id: r.id, organizationId: input.organizationId, status: "DRAFT", version: input.expectedVersion },
        data: { status: "PENDING_APPROVAL", budgetCheckStatus: check.status, amountAed: storedString(amountAed), fxRateToReporting: rate.rate.toString(), submittedAt: new Date(), approvalRequestId: req.request.id, version: { increment: 1 } },
      });
      if (res.count === 0) throw new Error("STALE");
      await audit(tx, { userId: input.actor.id, organizationId: input.organizationId, action: "SUBMIT", entityId: r.id, changes: { source: input.source, requestNo: r.requestNo, budgetId: budget.id, lineKey: line.lineKey, budgetCheck: check.status, exception: check.exception, amountReporting: payload.amountReporting, amountAed: storedString(amountAed), reportingToAedRate: payload.reportingToAedRate, rateSource: aed.source, approvalRequestId: req.request.id } });
      return req;
    });
    if (!outcome.ok) return fail("NO_APPROVER", outcome.message, ctx);
    apiLogger.info({ msg: "procurement/requests:submitted", budgetCheck: check.status, exception: check.exception, ...ctx });
    return getSpendRequest(input.organizationId, r.id);
  } catch (err) {
    if ((err as Error).message === "STALE") return fail("STALE_WRITE", "The request changed while you were submitting it. Reload.", ctx);
    apiLogger.error({ msg: "procurement/requests:submit-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not submit the spend request.", ctx);
  }
}

// ── the decision ─────────────────────────────────────────────────────────────

async function supplierIsApproved(client: Db, organizationId: string, supplierId: string | null): Promise<boolean> {
  if (!supplierId) return false;
  const s = await client.supplier.findFirst({ where: { id: supplierId, organizationId }, select: { approvalStatus: true, isActive: true } });
  return s?.approvalStatus === "APPROVED" && s.isActive === true;
}

/**
 * The approver decides the request's pending approval (from the inbox, by the
 * approval request id). A submission lands APPROVED, or AWAITING_SUPPLIER
 * while the supplier is not yet approved (spec §6); an amendment applies the
 * new amount on approval and leaves the old one standing on rejection.
 */
export async function decideSpendRequest(input: { organizationId: string; decider: ProcurementUserLike & { id: string }; source: Source; approvalRequestId: string; decision: "APPROVED" | "REJECTED"; note?: string | null }): Promise<SpendRequestResult<SpendRequestDetail>> {
  const ctx = { approvalRequestId: input.approvalRequestId, userId: input.decider.id };
  const approval = await db.approvalRequest.findFirst({ where: { id: input.approvalRequestId, organizationId: input.organizationId, subjectType: "SPEND_REQUEST" }, select: { id: true, subjectId: true, status: true, payload: true } });
  if (!approval) return fail("APPROVAL_FAILED", "No approval request was found for this spend request.", ctx);
  const r = await loadRequest(db, input.organizationId, approval.subjectId);
  if (!r) return fail("REQUEST_NOT_FOUND", "The spend request was not found.", ctx);
  if (r.status !== "PENDING_APPROVAL") return fail("INVALID_STATUS", "This request is not awaiting a decision.", ctx, { status: r.status });
  const payload = readApprovalPayload(approval.payload);
  if (!payload) return fail("APPROVAL_FAILED", "The approval request carries no spend-request payload.", ctx);
  // Set inside the transaction when the approval issued the order; read after the commit for the supplier email.
  let issuedCommitmentId: string | null = null;
  try {
    const outcome = await tenantTransaction(async (tx) => {
      const d = await decideApprovalRequest(tx, { organizationId: input.organizationId, requestId: approval.id, decider: input.decider, decision: input.decision, note: input.note, source: input.source });
      if (!d.ok) return d;
      // The budget may have moved on since the submit (a new version approved
      // archives this one; a close): an approval must not land on a version
      // that no longer takes requests, the reallocation decision's rule.
      if (input.decision === "APPROVED") {
        const budget = r.budgetId ? await tx.eventBudget.findFirst({ where: { id: r.budgetId, organizationId: input.organizationId }, select: { status: true } }) : null;
        if (!budget || !budgetAcceptsRequests(budget.status)) throw new Error("BUDGET_NOT_ACTIVE");
      }
      const now = new Date();
      const approvedSupplier = await supplierIsApproved(tx, input.organizationId, r.supplierId);
      const landing = approvedSupplier ? ("APPROVED" as const) : ("AWAITING_SUPPLIER" as const);
      let data: Prisma.SpendRequestUpdateManyMutationInput;
      if (payload.kind === "SUBMISSION") {
        data = input.decision === "APPROVED"
          ? { status: landing, decidedAt: now, decidedByUserId: input.decider.id, decisionNote: input.note?.trim() || null }
          : { status: "REJECTED", decidedAt: now, decidedByUserId: input.decider.id, decisionNote: input.note?.trim() || null };
      } else {
        // An amendment's decision lives on the approval trail; the request's
        // own decided-by and note stay the original decision's.
        data = input.decision === "APPROVED"
          ? { status: landing, amount: payload.nextAmount, taxAmount: payload.nextTaxAmount, amountAed: payload.nextAmountAed, budgetCheckStatus: payload.budgetCheck }
          : { status: payload.resumeStatus };
      }
      const res = await tx.spendRequest.updateMany({ where: { id: r.id, organizationId: input.organizationId, status: "PENDING_APPROVAL" }, data: { ...data, version: { increment: 1 } } });
      if (res.count === 0) throw new Error("STALE");
      await audit(tx, {
        userId: input.decider.id,
        organizationId: input.organizationId,
        action: input.decision === "APPROVED" ? (payload.kind === "AMENDMENT" ? "AMENDMENT_APPROVED" : "APPROVE") : (payload.kind === "AMENDMENT" ? "AMENDMENT_REJECTED" : "REJECT"),
        entityId: r.id,
        changes: { source: input.source, requestNo: r.requestNo, budgetId: r.budgetId, note: input.note?.trim() || null, landing: input.decision === "APPROVED" ? landing : null, ...(payload.kind === "AMENDMENT" ? { previousAmount: payload.previousAmount, nextAmount: payload.nextAmount } : {}) },
      });
      // Approval issues the order in the same transaction (spec §5: "approval
      // creates the purchase order"), so the two commit together or not at all.
      if (input.decision === "APPROVED" && landing === "APPROVED" && !r.linkedCommitmentId) {
        const issued = await issueOrderInTx(tx, { organizationId: input.organizationId, actorUserId: input.decider.id, source: input.source, requestId: r.id });
        if (!issued.ok) throw new Error(`ORDER:${issued.code}`);
        issuedCommitmentId = issued.commitmentId;
      }
      return d;
    });
    if (!outcome.ok) return fail("APPROVAL_FAILED", outcome.message, ctx, { code: outcome.code });
    if (issuedCommitmentId) await afterOrderIssued({ organizationId: input.organizationId, actorUserId: input.decider.id, source: input.source, commitmentId: issuedCommitmentId });
    return getSpendRequest(input.organizationId, r.id);
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (message === "STALE" || message === "ORDER:STALE_WRITE") return fail("STALE_WRITE", "The request changed while it was being decided. Reload.", ctx);
    if (message === "BUDGET_NOT_ACTIVE" || message === "ORDER:BUDGET_NOT_ACTIVE") return fail("BUDGET_NOT_ACTIVE", "The budget version this request was raised against no longer takes requests; the requester should raise it again on the current version.", ctx);
    if (message === "ORDER:LINE_NOT_FOUND") return fail("LINE_NOT_FOUND", "The request's line is no longer on the budget version; the order could not be issued and the decision was not recorded.", ctx);
    if (message.startsWith("ORDER:")) return fail("APPROVAL_FAILED", "The purchase order could not be issued, so the decision was not recorded.", ctx, { code: message.slice(6) });
    apiLogger.error({ msg: "procurement/requests:decide-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not record the decision.", ctx);
  }
}

// ── an amount change after approval ──────────────────────────────────────────

export async function amendSpendRequest(input: { organizationId: string; actor: Actor; source: Source; requestId: string; expectedVersion: number; amount: MoneyInput; taxAmount?: MoneyInput | null; reason: string; reportingToAedRate?: MoneyInput | null }): Promise<SpendRequestResult<SpendRequestDetail>> {
  const ctx = { requestId: input.requestId, userId: input.actor.id };
  const r = await loadRequest(db, input.organizationId, input.requestId);
  if (!r) return fail("REQUEST_NOT_FOUND", "The spend request was not found.", ctx);
  if (r.status !== "APPROVED" && r.status !== "AWAITING_SUPPLIER") return fail("INVALID_STATUS", "Only an approved request can have its amount changed.", ctx, { status: r.status });
  if (r.requesterUserId !== input.actor.id) return fail("NOT_REQUESTER", "Only the person who raised this request can change its amount.", ctx);
  if (!r.budgetId || !r.lineKey || r.fxRateToReporting === null) return fail("INCOMPLETE", "The request has no budget line to check against.", ctx);
  if (money(input.amount).lte(0)) return fail("INVALID_AMOUNT", "The amount must be greater than zero.", ctx);
  const rate = money(r.fxRateToReporting);
  const previousReporting = toReporting(r.amount, rate);
  const nextReporting = toReporting(input.amount, rate);
  const effect = amendmentEffect(previousReporting, nextReporting);
  if (effect.direction === "SAME") return fail("INVALID_AMOUNT", "The amount is unchanged.", ctx);
  const nextTax = storedString(input.taxAmount ?? r.taxAmount);
  const budget = await db.eventBudget.findFirst({ where: { id: r.budgetId, organizationId: input.organizationId }, select: { id: true, status: true, reportingCurrency: true } });
  if (!budget) return fail("BUDGET_NOT_FOUND", "The budget was not found.", ctx);
  if (!budgetAcceptsRequests(budget.status)) return fail("BUDGET_NOT_ACTIVE", `This version is ${budget.status.toLowerCase().replace("_", " ")} and takes no change.`, ctx, { status: budget.status });
  const line = await loadLine(db, budget.id, r.lineKey);
  if (!line) return fail("LINE_NOT_FOUND", "That line is no longer on this budget version.", ctx);
  if (effect.direction === "DECREASE") {
    // Applied at once; the check is re-read so a request lowered back within the line drops its exception badge.
    const lowered = budgetCheck({ budgetStatus: budget.status, line, amountReporting: nextReporting, alreadyCommitted: r.linkedCommitmentId ? previousReporting : 0 });
    try {
      const res = await db.spendRequest.updateMany({
        where: { id: r.id, organizationId: input.organizationId, status: r.status, version: input.expectedVersion },
        data: { amount: storedString(input.amount), taxAmount: nextTax, amountAed: r.amountAed === null ? null : storedString(toStored(money(r.amountAed).mul(nextReporting).div(previousReporting))), budgetCheckStatus: lowered.status, version: { increment: 1 } },
      });
      if (res.count === 0) return fail("STALE_WRITE", "Someone else changed this request; reload and try again.", ctx, { currentVersion: r.version });
      await audit(db, { userId: input.actor.id, organizationId: input.organizationId, action: "AMEND", entityId: r.id, changes: { source: input.source, requestNo: r.requestNo, budgetId: r.budgetId, previousAmount: storedString(r.amount), nextAmount: storedString(input.amount), deltaReporting: storedString(effect.delta), reason: input.reason.trim() } });
      return getSpendRequest(input.organizationId, r.id);
    } catch (err) {
      apiLogger.error({ msg: "procurement/requests:amend-failed", err, ...ctx });
      return fail("UNKNOWN", "Could not change the amount.", ctx);
    }
  }
  // A rise: the budget check on the NEW TOTAL, routed on the new total, approved for the difference (spec §6).
  // Before conversion the request holds nothing on the line, so the whole new
  // total is checked; once a commitment carries the old amount in
  // committedOpen, only the rise is new money.
  const check = budgetCheck({ budgetStatus: budget.status, line, amountReporting: nextReporting, alreadyCommitted: r.linkedCommitmentId ? previousReporting : 0 });
  const aed = resolveReportingToAedRate(budget.reportingCurrency, input.reportingToAedRate);
  if (!aed.ok) return fail("RATE_REQUIRED", rateRefusal(budget.reportingCurrency, aed), ctx, { reason: aed.reason });
  const nextAmountAed = toAed(nextReporting, aed.rate);
  const payload: AmendmentPayload = {
    kind: "AMENDMENT",
    budgetId: budget.id,
    lineKey: line.lineKey,
    resumeStatus: r.status,
    previousAmount: storedString(r.amount),
    nextAmount: storedString(input.amount),
    nextTaxAmount: nextTax,
    nextAmountAed: storedString(nextAmountAed),
    deltaReporting: storedString(effect.delta),
    budgetCheck: check.status,
    reason: input.reason.trim(),
    reportingToAedRate: aed.rate.toString(),
    rateSource: aed.source,
  };
  try {
    const outcome = await tenantTransaction(async (tx) => {
      const req = await createApprovalRequest(tx, {
        organizationId: input.organizationId,
        subjectType: "SPEND_REQUEST",
        subjectId: r.id,
        amountAed: Number(nextAmountAed.toString()),
        amount: storedString(input.amount),
        currency: r.currency,
        requesterUserId: input.actor.id,
        reason: input.reason.trim(),
        payload,
        requireFinalApprover: check.exception,
        source: input.source,
      });
      if (!req.ok) return req;
      const res = await tx.spendRequest.updateMany({
        where: { id: r.id, organizationId: input.organizationId, status: r.status, version: input.expectedVersion },
        data: { status: "PENDING_APPROVAL", approvalRequestId: req.request.id, version: { increment: 1 } },
      });
      if (res.count === 0) throw new Error("STALE");
      await audit(tx, { userId: input.actor.id, organizationId: input.organizationId, action: "AMENDMENT_REQUESTED", entityId: r.id, changes: { source: input.source, requestNo: r.requestNo, budgetId: budget.id, previousAmount: payload.previousAmount, nextAmount: payload.nextAmount, deltaReporting: payload.deltaReporting, budgetCheck: check.status, exception: check.exception, reason: payload.reason, approvalRequestId: req.request.id } });
      return req;
    });
    if (!outcome.ok) return fail("NO_APPROVER", outcome.message, ctx);
    return getSpendRequest(input.organizationId, r.id);
  } catch (err) {
    if ((err as Error).message === "STALE") return fail("STALE_WRITE", "The request changed while you were editing it. Reload.", ctx);
    apiLogger.error({ msg: "procurement/requests:amend-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not route the change.", ctx);
  }
}

// ── withdraw and cancel ──────────────────────────────────────────────────────

export async function transitionSpendRequest(input: { organizationId: string; actor: Actor; source: Source; requestId: string; expectedVersion: number; action: "withdraw" | "cancel"; reason?: string | null }): Promise<SpendRequestResult<SpendRequestDetail>> {
  const ctx = { requestId: input.requestId, userId: input.actor.id, action: input.action };
  const r = await loadRequest(db, input.organizationId, input.requestId);
  if (!r) return fail("REQUEST_NOT_FOUND", "The spend request was not found.", ctx);
  const reason = input.reason?.trim() || null;
  if (input.action === "withdraw") {
    if (r.status !== "PENDING_APPROVAL") return fail("INVALID_STATUS", "Only a request awaiting approval can be withdrawn.", ctx, { status: r.status });
    if (r.requesterUserId !== input.actor.id) return fail("NOT_REQUESTER", "Only the person who raised this request can withdraw it.", ctx);
  } else {
    if (!["DRAFT", "PENDING_APPROVAL", "APPROVED", "AWAITING_SUPPLIER"].includes(r.status)) return fail("INVALID_STATUS", `A ${SPEND_REQUEST_STATUS_LABEL[r.status as SpendRequestStatusValue].toLowerCase()} request cannot be cancelled.`, ctx, { status: r.status });
    if (r.linkedCommitmentId) return fail("INVALID_STATUS", "This request already has a purchase order; cancel the order instead.", ctx);
    if (r.requesterUserId !== input.actor.id && !input.actor.isAdmin) return fail("NOT_REQUESTER", "Only the person who raised this request, or an admin, can cancel it.", ctx);
    if (!reason) return fail("REASON_REQUIRED", "Give the reason for cancelling.", ctx);
  }
  try {
    await tenantTransaction(async (tx) => {
      // A withdrawn amendment goes back to where it was; a withdrawn submission goes back to draft.
      let resume: SpendRequestStatusValue = "DRAFT";
      if (input.action === "withdraw" && r.approvalRequestId) {
        const pending = await tx.approvalRequest.findFirst({ where: { id: r.approvalRequestId, organizationId: input.organizationId }, select: { payload: true } });
        const p = readApprovalPayload(pending?.payload);
        if (p?.kind === "AMENDMENT") resume = p.resumeStatus;
      }
      await cancelPendingApprovals(tx, { organizationId: input.organizationId, subjectType: "SPEND_REQUEST", subjectId: r.id, actorUserId: input.actor.id, source: input.source });
      const data: Prisma.SpendRequestUpdateManyMutationInput = input.action === "withdraw"
        ? { status: resume, approvalRequestId: null, ...(resume === "DRAFT" ? { budgetCheckStatus: "NOT_CHECKED", amountAed: null, submittedAt: null } : {}) }
        : { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason };
      const res = await tx.spendRequest.updateMany({ where: { id: r.id, organizationId: input.organizationId, status: r.status, version: input.expectedVersion }, data: { ...data, version: { increment: 1 } } });
      if (res.count === 0) throw new Error("STALE");
      await audit(tx, { userId: input.actor.id, organizationId: input.organizationId, action: input.action === "withdraw" ? "WITHDRAW" : "CANCEL", entityId: r.id, changes: { source: input.source, requestNo: r.requestNo, budgetId: r.budgetId, from: r.status, reason } });
    });
    return getSpendRequest(input.organizationId, r.id);
  } catch (err) {
    if ((err as Error).message === "STALE") return fail("STALE_WRITE", "The request changed while you were acting on it. Reload.", ctx);
    apiLogger.error({ msg: "procurement/requests:transition-failed", err, ...ctx });
    return fail("UNKNOWN", `Could not ${input.action} the spend request.`, ctx);
  }
}

// ── quotes ───────────────────────────────────────────────────────────────────

export interface AddQuoteInput {
  organizationId: string;
  actor: Actor;
  source: Source;
  requestId: string;
  vendorName: string;
  supplierId?: string | null;
  amount: MoneyInput;
  taxAmount?: MoneyInput | null;
  currency: string;
  quotedOn?: string | null;
  validUntil?: string | null;
  recommended?: boolean;
  notes?: string | null;
}

export async function addQuote(input: AddQuoteInput): Promise<SpendRequestResult<SpendRequestDetail>> {
  const ctx = { requestId: input.requestId, userId: input.actor.id };
  const r = await loadRequest(db, input.organizationId, input.requestId);
  if (!r) return fail("REQUEST_NOT_FOUND", "The spend request was not found.", ctx);
  if (r.status !== "DRAFT") return fail("INVALID_STATUS", "Quotes are attached to a draft; withdraw the request first.", ctx, { status: r.status });
  if (r.requesterUserId !== input.actor.id && !input.actor.isAdmin) return fail("NOT_REQUESTER", "Only the person who raised this request can attach a quote.", ctx);
  if (money(input.amount).lte(0)) return fail("INVALID_AMOUNT", "A quote's amount must be greater than zero.", ctx);
  if (input.supplierId) {
    const s = await db.supplier.findFirst({ where: { id: input.supplierId, organizationId: input.organizationId }, select: { id: true } });
    if (!s) return fail("SUPPLIER_NOT_FOUND", "The supplier was not found.", ctx);
  }
  try {
    await tenantTransaction(async (tx) => {
      // The draft is claimed inside the write, so a submit that commits between the read and this point loses one of the two rather than gaining a quote after submission.
      const claim = await tx.spendRequest.updateMany({ where: { id: r.id, organizationId: input.organizationId, status: "DRAFT" }, data: { version: { increment: 1 } } });
      if (claim.count === 0) throw new Error("STALE");
      if (input.recommended) await tx.spendRequestQuote.updateMany({ where: { spendRequestId: r.id, recommended: true }, data: { recommended: false } });
      const q = await tx.spendRequestQuote.create({
        data: {
          organizationId: input.organizationId,
          spendRequestId: r.id,
          vendorName: input.vendorName.trim(),
          supplierId: input.supplierId ?? null,
          amount: storedString(input.amount),
          taxAmount: storedString(input.taxAmount ?? 0),
          currency: input.currency.toUpperCase(),
          quotedOn: toDay(input.quotedOn),
          validUntil: toDay(input.validUntil),
          recommended: input.recommended === true,
          notes: input.notes?.trim() || null,
        },
        select: { id: true },
      });
      await audit(tx, { userId: input.actor.id, organizationId: input.organizationId, action: "QUOTE_ADDED", entityId: r.id, changes: { source: input.source, requestNo: r.requestNo, budgetId: r.budgetId, quoteId: q.id, vendorName: input.vendorName.trim(), amount: storedString(input.amount), currency: input.currency.toUpperCase(), recommended: input.recommended === true } });
    });
    return getSpendRequest(input.organizationId, r.id);
  } catch (err) {
    if ((err as Error).message === "STALE") return fail("STALE_WRITE", "The request was submitted while you were attaching the quote. Reload.", ctx);
    apiLogger.error({ msg: "procurement/requests:quote-add-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not attach the quote.", ctx);
  }
}

export async function removeQuote(input: { organizationId: string; actor: Actor; source: Source; requestId: string; quoteId: string }): Promise<SpendRequestResult<SpendRequestDetail>> {
  const ctx = { requestId: input.requestId, quoteId: input.quoteId, userId: input.actor.id };
  const r = await loadRequest(db, input.organizationId, input.requestId);
  if (!r) return fail("REQUEST_NOT_FOUND", "The spend request was not found.", ctx);
  if (r.status !== "DRAFT") return fail("INVALID_STATUS", "Quotes change on a draft only; withdraw the request first.", ctx, { status: r.status });
  if (r.requesterUserId !== input.actor.id && !input.actor.isAdmin) return fail("NOT_REQUESTER", "Only the person who raised this request can remove a quote.", ctx);
  try {
    // Bound to a DRAFT parent in the same statement, so a submit racing this cannot strip the quote it was checked on.
    const res = await db.spendRequestQuote.deleteMany({ where: { id: input.quoteId, spendRequestId: r.id, organizationId: input.organizationId, spendRequest: { status: "DRAFT" } } });
    if (res.count === 0) return fail("QUOTE_NOT_FOUND", "That quote is not on this request, or the request is no longer a draft.", ctx);
    await audit(db, { userId: input.actor.id, organizationId: input.organizationId, action: "QUOTE_REMOVED", entityId: r.id, changes: { source: input.source, requestNo: r.requestNo, budgetId: r.budgetId, quoteId: input.quoteId } });
    return getSpendRequest(input.organizationId, r.id);
  } catch (err) {
    apiLogger.error({ msg: "procurement/requests:quote-remove-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not remove the quote.", ctx);
  }
}

/**
 * The quote document itself (slice 3). The route stores the file under the
 * private procurement-quotes prefix first, then records it here; on a
 * refusal the route removes the file again. A draft's quote only, claimed
 * in the same statement (the addQuote rule). Returns the path it replaced
 * so the route can delete the old file after the row is updated.
 */
export async function setQuoteFile(input: { organizationId: string; actor: Actor; source: Source; requestId: string; quoteId: string; fileUrl: string | null; fileName: string | null; fileMimeType: string | null; fileSize: number | null }): Promise<SpendRequestResult<SpendRequestDetail> & { replacedFileUrl?: string | null }> {
  const ctx = { requestId: input.requestId, quoteId: input.quoteId, userId: input.actor.id };
  const r = await loadRequest(db, input.organizationId, input.requestId);
  if (!r) return fail("REQUEST_NOT_FOUND", "The spend request was not found.", ctx);
  if (r.status !== "DRAFT") return fail("INVALID_STATUS", "A quote's file changes on a draft only; withdraw the request first.", ctx, { status: r.status });
  if (r.requesterUserId !== input.actor.id && !input.actor.isAdmin) return fail("NOT_REQUESTER", "Only the person who raised this request can change a quote's file.", ctx);
  const quote = r.quotes.find((q) => q.id === input.quoteId);
  if (!quote) return fail("QUOTE_NOT_FOUND", "That quote is not on this request.", ctx);
  try {
    const res = await db.spendRequestQuote.updateMany({
      where: { id: quote.id, spendRequestId: r.id, organizationId: input.organizationId, spendRequest: { status: "DRAFT" } },
      data: { fileUrl: input.fileUrl, fileName: input.fileName, fileMimeType: input.fileMimeType, fileSize: input.fileSize },
    });
    if (res.count === 0) return fail("STALE_WRITE", "The request was submitted while the file was being attached. Reload.", ctx);
    await audit(db, { userId: input.actor.id, organizationId: input.organizationId, action: input.fileUrl ? "QUOTE_FILE_ATTACHED" : "QUOTE_FILE_REMOVED", entityId: r.id, changes: { source: input.source, requestNo: r.requestNo, budgetId: r.budgetId, quoteId: quote.id, fileName: input.fileName, fileSize: input.fileSize } });
    const detail = await getSpendRequest(input.organizationId, r.id);
    return { ...detail, replacedFileUrl: quote.fileUrl };
  } catch (err) {
    apiLogger.error({ msg: "procurement/requests:quote-file-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not record the quote's file.", ctx);
  }
}
