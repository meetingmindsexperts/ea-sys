/**
 * Purchase orders (spec §5, §6, §7.7): the commitment an approved spend
 * request becomes. Approval issues the order at once (inside the decision's
 * own transaction, so approval and order commit together or not at all),
 * an "awaiting supplier" request converts the moment its supplier is
 * approved, and the requester or an admin can raise it by hand when
 * something went wrong or after a cancel (cancel and re-issue is the only
 * change a posted order takes). Issuing an order raises the budget line's
 * committed figures; cancelling releases them. Receiving is the requester's
 * mark, and a full receipt of AED 50,000 or more needs a second person.
 *
 * ONE implementation for the routes, the pages and the MCP reads. Errors as
 * values (src/services/README.md). Runs inside the caller's tenant lane;
 * every mutating write is conditional on the version it read; every
 * transition writes an AuditLog row with `source`.
 *
 * Boundary: spend-request-service and supplier-service import THIS file;
 * this file never imports either, so the graph has no cycle.
 */
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { canAdminProcurement, canApproveProcurement, canRequestProcurement, canSettleProcurement, procurementGrantsFromRow } from "@/lib/procurement-visibility";
import { sendEmail } from "@/lib/email";
import type { Prisma } from "@prisma/client";
import type { Db } from "@/lib/approvals/approvals-service";
import { nextDocumentNumber } from "../lib/document-numbers";
import { money, storedString, type MoneyInput } from "../lib/money";
import { budgetAcceptsRequests, toReporting } from "../lib/spend-request-rules";
import {
  COMMITMENT_STATUS_LABEL,
  FULFILLMENT_LABEL,
  orderReadiness,
  receiptNeedsSecondPerson,
  type CommitmentStatusValue,
  type FulfillmentStatusValue,
} from "../lib/commitment-rules";
import { generatePurchaseOrderPdf } from "../lib/commitment-pdf";
import { recomputeBudgetTotals } from "./budget-service";
import { eventBudgetClosed, syncLineCommitted } from "./committed-figures";
import { rerouteAfterOrderCancelInTx, type RerouteOutcome } from "./spend-request-reroute";

export type CommitmentErrorCode =
  | "COMMITMENT_NOT_FOUND"
  | "REQUEST_NOT_FOUND"
  | "INVALID_STATUS"
  | "ALREADY_ORDERED"
  | "SUPPLIER_NOT_APPROVED"
  | "BUDGET_NOT_ACTIVE"
  | "BUDGET_CLOSED"
  | "LINE_NOT_FOUND"
  | "NOT_ALLOWED"
  | "REASON_REQUIRED"
  | "NO_SUPPLIER_EMAIL"
  | "SEND_FAILED"
  | "STALE_WRITE"
  | "INVALID_FILTER"
  | "UNKNOWN";

export type CommitmentRefusal = { ok: false; code: CommitmentErrorCode; message: string; meta?: Record<string, unknown> };
export type CommitmentResult<T> = { ok: true; commitment: T } | CommitmentRefusal;

type Source = "ui" | "mcp";

/** Who is acting on an order: the routes pass the session id and the grants the guard resolved. */
export interface OrderActor {
  id: string;
  isAdmin: boolean;
  canRequest: boolean;
  canSettle: boolean;
  /** Holds an approval ceiling or the unlimited grant: the "approver" of the second-person rule. */
  canApprove: boolean;
}

export const COMMITMENT_SELECT = {
  id: true, organizationId: true, commitmentNo: true, spendRequestId: true, budgetId: true, lineKey: true, supplierId: true, eventCode: true,
  amount: true, taxAmount: true, currency: true, fxRateToReporting: true, status: true, fulfillmentStatus: true, accountingSyncStatus: true,
  approvedAt: true, approvedByUserId: true, sentToSupplierAt: true, receivedAt: true, receivedByUserId: true, receiptConfirmedAt: true, receiptConfirmedByUserId: true,
  cancelledAt: true, cancelledByUserId: true, cancelReason: true, closedAt: true, version: true, createdAt: true, updatedAt: true,
  supplier: { select: { id: true, code: true, displayName: true, legalName: true, contacts: true, country: true, currency: true, paymentTerms: true, approvalStatus: true, isActive: true } },
  spendRequest: { select: { id: true, requestNo: true, title: true, requesterUserId: true, amountAed: true, emailSupplierOnIssue: true } },
  budget: { select: { id: true, eventCode: true, versionNo: true, status: true, reportingCurrency: true, event: { select: { name: true } } } },
  lines: { select: { id: true, lineKey: true, categoryId: true, description: true, qty: true, unitCost: true, taxCode: true, taxRatePercent: true, amount: true, taxAmount: true, sortOrder: true }, orderBy: { sortOrder: "asc" } },
} as const;
type Row = Prisma.CommitmentGetPayload<{ select: typeof COMMITMENT_SELECT }>;

/** The request as the order needs it: enough to issue, nothing the request service owns. */
const REQUEST_FOR_ORDER_SELECT = {
  id: true, requestNo: true, budgetId: true, lineKey: true, eventCode: true, requesterUserId: true, decidedByUserId: true, supplierId: true, title: true,
  amount: true, taxAmount: true, currency: true, fxRateToReporting: true, amountAed: true, categoryId: true, status: true, linkedCommitmentId: true, emailSupplierOnIssue: true, version: true,
  supplier: { select: { id: true, approvalStatus: true, isActive: true } },
} as const;

const s4 = (v: MoneyInput | null | undefined) => (v === null || v === undefined ? null : storedString(v));

/** The contacts JSON on the supplier, read defensively: the master accepts up to ten `{ name, email?, phone?, role? }`. */
export function supplierContactEmails(contacts: unknown): { name: string; email: string }[] {
  if (!Array.isArray(contacts)) return [];
  const out: { name: string; email: string }[] = [];
  for (const c of contacts) {
    if (!c || typeof c !== "object") continue;
    const email = (c as { email?: unknown }).email;
    const name = (c as { name?: unknown }).name;
    if (typeof email === "string" && email.includes("@")) out.push({ name: typeof name === "string" ? name : "", email: email.trim() });
  }
  return out;
}

export function toCommitmentView(c: Row) {
  const rate = money(c.fxRateToReporting);
  const contacts = supplierContactEmails(c.supplier.contacts);
  return {
    ...c,
    amount: storedString(c.amount),
    taxAmount: storedString(c.taxAmount),
    fxRateToReporting: rate.toString(),
    /** The ex-VAT amount in the budget's reporting currency, the figure committed on the line. */
    amountReporting: storedString(toReporting(c.amount, rate)),
    amountAed: s4(c.spendRequest?.amountAed),
    statusLabel: COMMITMENT_STATUS_LABEL[c.status as CommitmentStatusValue] ?? c.status,
    fulfillmentLabel: FULFILLMENT_LABEL[c.fulfillmentStatus as FulfillmentStatusValue] ?? c.fulfillmentStatus,
    /** A full receipt of this order needs a second person (spec §6, from AED 50,000). */
    receiptNeedsSecondPerson: receiptNeedsSecondPerson(c.spendRequest?.amountAed),
    receiptConfirmed: c.receiptConfirmedAt !== null,
    emailSupplierOnIssue: c.spendRequest?.emailSupplierOnIssue ?? false,
    supplier: { ...c.supplier, contacts: undefined, contactEmails: contacts },
    lines: c.lines.map((l) => ({ ...l, qty: storedString(l.qty), unitCost: storedString(l.unitCost), taxRatePercent: l.taxRatePercent === null ? null : money(l.taxRatePercent).toString(), amount: storedString(l.amount), taxAmount: storedString(l.taxAmount) })),
  };
}
export type CommitmentView = ReturnType<typeof toCommitmentView>;

export type CommitmentDetail = CommitmentView & {
  requesterName: string | null;
  approvedByName: string | null;
  receivedByName: string | null;
  receiptConfirmedByName: string | null;
  cancelledByName: string | null;
};

function fail(code: CommitmentErrorCode, message: string, ctx: Record<string, unknown> = {}, meta?: Record<string, unknown>): CommitmentRefusal {
  apiLogger.warn({ msg: "procurement/commitments:rejected", code, ...ctx });
  return { ok: false, code, message, ...(meta ? { meta } : {}) };
}

async function audit(client: Db, data: { userId: string; organizationId: string; action: string; entityType: "Commitment" | "SpendRequest"; entityId: string; changes: Prisma.InputJsonValue }) {
  await client.auditLog.create({ data }).catch((err) => apiLogger.error({ msg: "procurement/commitments:audit-failed", err, action: data.action }));
}

async function loadCommitment(client: Db, organizationId: string, commitmentId: string) {
  return client.commitment.findFirst({ where: { id: commitmentId, organizationId }, select: COMMITMENT_SELECT });
}

async function userNames(client: Db, organizationId: string, ids: string[]): Promise<Map<string, string>> {
  const wanted = Array.from(new Set(ids.filter(Boolean)));
  if (wanted.length === 0) return new Map();
  const rows = await client.user.findMany({ where: { id: { in: wanted }, organizationId }, select: { id: true, firstName: true, lastName: true } });
  return new Map(rows.map((u) => [u.id, `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim()]));
}

// ── read ─────────────────────────────────────────────────────────────────────

const STATUS_FILTERS: ReadonlySet<string> = new Set(Object.keys(COMMITMENT_STATUS_LABEL));
/** A status the enum does not know is refused, never silently widened (the INVALID_FILTER rule). */
export function invalidCommitmentStatusFilter(status: string | undefined): boolean {
  return status !== undefined && !STATUS_FILTERS.has(status);
}

export async function listCommitments(organizationId: string, filter: { status?: string; budgetId?: string; supplierId?: string } = {}) {
  const rows = await db.commitment.findMany({
    where: { organizationId, ...(filter.status ? { status: filter.status as CommitmentStatusValue } : {}), ...(filter.budgetId ? { budgetId: filter.budgetId } : {}), ...(filter.supplierId ? { supplierId: filter.supplierId } : {}) },
    select: COMMITMENT_SELECT,
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const names = await userNames(db, organizationId, rows.map((r) => r.spendRequest?.requesterUserId ?? ""));
  return rows.map((r) => ({ ...toCommitmentView(r), requesterName: r.spendRequest ? (names.get(r.spendRequest.requesterUserId) ?? null) : null }));
}

export async function getCommitment(organizationId: string, commitmentId: string): Promise<CommitmentResult<CommitmentDetail>> {
  const c = await loadCommitment(db, organizationId, commitmentId);
  if (!c) return fail("COMMITMENT_NOT_FOUND", "The purchase order was not found.", { commitmentId });
  const names = await userNames(db, organizationId, [c.spendRequest?.requesterUserId ?? "", c.approvedByUserId ?? "", c.receivedByUserId ?? "", c.receiptConfirmedByUserId ?? "", c.cancelledByUserId ?? ""]);
  const name = (id: string | null | undefined) => (id ? (names.get(id) ?? null) : null);
  return {
    ok: true,
    commitment: {
      ...toCommitmentView(c),
      requesterName: name(c.spendRequest?.requesterUserId),
      approvedByName: name(c.approvedByUserId),
      receivedByName: name(c.receivedByUserId),
      receiptConfirmedByName: name(c.receiptConfirmedByUserId),
      cancelledByName: name(c.cancelledByUserId),
    },
  };
}

// ── issue ────────────────────────────────────────────────────────────────────

/**
 * The actor's grants as the user row holds them now. The session carries them
 * too but refreshes only every five minutes, so a grant removed a moment ago
 * would still let someone cancel an order or confirm a receipt; those two read
 * the row, the way the approval decision does.
 */
async function actorFromRow(organizationId: string, actor: OrderActor): Promise<OrderActor> {
  const row = await db.user.findFirst({
    where: { id: actor.id, organizationId, deactivatedAt: null },
    select: { role: true, procurementRequest: true, procurementApproveCeilingAed: true, procurementApproveUnlimited: true, procurementSettle: true },
  });
  if (!row) {
    apiLogger.warn({ msg: "procurement/commitments:actor-row-missing", userId: actor.id, organizationId });
    return { id: actor.id, isAdmin: false, canRequest: false, canSettle: false, canApprove: false };
  }
  const user = { role: row.role, ...procurementGrantsFromRow(row) };
  const fresh: OrderActor = { id: actor.id, isAdmin: canAdminProcurement(user), canRequest: canRequestProcurement(user), canSettle: canSettleProcurement(user), canApprove: canApproveProcurement(user, 0) };
  const changed = fresh.isAdmin !== actor.isAdmin || fresh.canRequest !== actor.canRequest || fresh.canSettle !== actor.canSettle || fresh.canApprove !== actor.canApprove;
  if (changed) apiLogger.info({ msg: "procurement/commitments:grants-changed-since-sign-in", userId: actor.id, organizationId, session: actor, now: fresh });
  return fresh;
}

/** The requester of the linked request (holding the request grant), the settle holder, or an admin. */
function actsOnOrder(actor: OrderActor, requesterUserId: string | null | undefined): boolean {
  if (actor.isAdmin || actor.canSettle) return true;
  return !!requesterUserId && actor.id === requesterUserId && actor.canRequest;
}

/**
 * Issue the order for an approved request INSIDE the caller's transaction:
 * the decision's own transaction, the supplier-approval conversion, or the
 * manual raise. Takes the PO number, copies the request into one order line,
 * marks the request CONVERTED, raises the budget line's committed figures
 * and recomputes the budget totals; two audit rows. Returns the order id,
 * or a refusal that rolls the caller back.
 */
export async function issueOrderInTx(tx: Db, input: { organizationId: string; actorUserId: string; source: Source; requestId: string }): Promise<{ ok: true; commitmentId: string; commitmentNo: string } | CommitmentRefusal> {
  const ctx = { requestId: input.requestId, userId: input.actorUserId };
  const r = await tx.spendRequest.findFirst({ where: { id: input.requestId, organizationId: input.organizationId }, select: REQUEST_FOR_ORDER_SELECT });
  if (!r) return fail("REQUEST_NOT_FOUND", "The spend request was not found.", ctx);
  const readiness = orderReadiness(r);
  if (!readiness.ready) {
    if (readiness.reason === "already-ordered") return fail("ALREADY_ORDERED", "This request already has a purchase order.", ctx, { commitmentId: r.linkedCommitmentId });
    if (readiness.reason === "supplier") return fail("SUPPLIER_NOT_APPROVED", "The order waits until the supplier is approved and active on the Suppliers page.", ctx);
    return fail("INVALID_STATUS", "Only an approved request becomes a purchase order.", ctx, { status: r.status });
  }
  if (!r.budgetId || !r.lineKey || !r.supplierId) return fail("LINE_NOT_FOUND", "The request has no budget line or supplier to order against.", ctx);
  const budget = await tx.eventBudget.findFirst({ where: { id: r.budgetId, organizationId: input.organizationId }, select: { id: true, status: true, reportingCurrency: true } });
  if (!budget || !budgetAcceptsRequests(budget.status)) return fail("BUDGET_NOT_ACTIVE", "The budget version this request was raised against no longer takes orders; raise it again on the current version.", ctx);
  const line = await tx.budgetLine.findFirst({ where: { budgetId: r.budgetId, lineKey: r.lineKey, deletedAt: null }, select: { id: true, committedOpen: true, committedTotal: true, taxRatePercent: true, taxCode: true } });
  if (!line) return fail("LINE_NOT_FOUND", "That line is no longer on the budget version.", ctx);

  const now = new Date();
  const amountReporting = toReporting(r.amount, money(r.fxRateToReporting));
  const commitmentNo = await nextDocumentNumber(tx, "PO", input.organizationId, now);
  const created = await tx.commitment.create({
    data: {
      organizationId: input.organizationId,
      commitmentNo,
      spendRequestId: r.id,
      budgetId: r.budgetId,
      lineKey: r.lineKey,
      supplierId: r.supplierId,
      eventCode: r.eventCode,
      amount: storedString(r.amount),
      taxAmount: storedString(r.taxAmount),
      currency: r.currency,
      fxRateToReporting: money(r.fxRateToReporting).toString(),
      status: "APPROVED",
      fulfillmentStatus: "OPEN",
      accountingSyncStatus: "PENDING",
      approvedAt: now,
      // The approver of record is whoever decided the request, not whoever set off the issue
      // (a supplier's approval, or a by-hand raise after a failed conversion).
      approvedByUserId: r.decidedByUserId ?? input.actorUserId,
      lines: {
        create: [{
          organizationId: input.organizationId,
          lineKey: r.lineKey,
          categoryId: r.categoryId,
          description: r.title,
          qty: "1",
          unitCost: storedString(r.amount),
          taxCode: line.taxCode,
          taxRatePercent: money(r.amount).gt(0) && money(r.taxAmount).gt(0) ? money(r.taxAmount).div(money(r.amount)).times(100).toDecimalPlaces(2).toString() : null,
          amount: storedString(r.amount),
          taxAmount: storedString(r.taxAmount),
          sortOrder: 0,
        }],
      },
    },
    select: { id: true },
  });
  const res = await tx.spendRequest.updateMany({
    where: { id: r.id, organizationId: input.organizationId, status: { in: ["APPROVED", "AWAITING_SUPPLIER"] }, linkedCommitmentId: null },
    data: { status: "CONVERTED", linkedCommitmentId: created.id, version: { increment: 1 } },
  });
  if (res.count === 0) return fail("STALE_WRITE", "The request changed while the order was being issued. Reload.", ctx);
  // Summed from the orders under the event's lock, never incremented: see committed-figures.ts.
  const committedOn = await syncLineCommitted(tx, { organizationId: input.organizationId, budgetId: r.budgetId, lineKey: r.lineKey });
  await recomputeBudgetTotals(tx, committedOn ?? r.budgetId);
  await audit(tx, { userId: input.actorUserId, organizationId: input.organizationId, action: "CREATE", entityType: "Commitment", entityId: created.id, changes: { source: input.source, commitmentNo, requestNo: r.requestNo, requestId: r.id, budgetId: r.budgetId, lineKey: r.lineKey, supplierId: r.supplierId, amount: storedString(r.amount), taxAmount: storedString(r.taxAmount), currency: r.currency, amountReporting: storedString(amountReporting) } });
  await audit(tx, { userId: input.actorUserId, organizationId: input.organizationId, action: "CONVERT", entityType: "SpendRequest", entityId: r.id, changes: { source: input.source, requestNo: r.requestNo, commitmentNo, commitmentId: created.id, budgetId: r.budgetId, from: r.status } });
  apiLogger.info({ msg: "procurement/commitments:issued", commitmentId: created.id, commitmentNo, ...ctx, organizationId: input.organizationId });
  return { ok: true, commitmentId: created.id, commitmentNo };
}

/**
 * After an order commits: email the PDF to the supplier when the requester
 * asked for it at raise time. Never throws and never undoes the order; a
 * failed send is logged and the order page offers Send.
 */
export type AutoSendOutcome = { requested: false } | { requested: true; sent: true } | { requested: true; sent: false; code: string };

export async function afterOrderIssued(input: { organizationId: string; actorUserId: string; source: Source; commitmentId: string }): Promise<AutoSendOutcome> {
  try {
    const c = await loadCommitment(db, input.organizationId, input.commitmentId);
    if (!c?.spendRequest?.emailSupplierOnIssue) return { requested: false };
    const sent = await sendOrderToSupplier({ organizationId: input.organizationId, actor: { id: input.actorUserId, isAdmin: true, canRequest: false, canSettle: false, canApprove: false }, source: input.source, commitmentId: input.commitmentId });
    if (!sent.ok) {
      apiLogger.warn({ msg: "procurement/commitments:auto-send-skipped", code: sent.code, commitmentId: input.commitmentId, organizationId: input.organizationId });
      return { requested: true, sent: false, code: sent.code };
    }
    return { requested: true, sent: true };
  } catch (err) {
    apiLogger.error({ msg: "procurement/commitments:auto-send-failed", err, commitmentId: input.commitmentId, organizationId: input.organizationId });
    // Whether the email was asked for is unknown here, so the person is told to check the order.
    return { requested: true, sent: false, code: "UNKNOWN" };
  }
}

/** The manual raise: the requester (with the grant) or an admin, on an approved request that has no order yet (a conversion that failed). A cancel sends the request back for approval instead. */
export async function raiseOrder(input: { organizationId: string; actor: OrderActor; source: Source; requestId: string }): Promise<CommitmentResult<CommitmentDetail> & { autoSend?: AutoSendOutcome }> {
  const ctx = { requestId: input.requestId, userId: input.actor.id };
  const r = await db.spendRequest.findFirst({ where: { id: input.requestId, organizationId: input.organizationId }, select: { requesterUserId: true } });
  if (!r) return fail("REQUEST_NOT_FOUND", "The spend request was not found.", ctx);
  if (!(input.actor.isAdmin || (input.actor.id === r.requesterUserId && input.actor.canRequest))) return fail("NOT_ALLOWED", "Only the person who raised the request, or an admin, can raise its purchase order.", ctx);
  let issued: Awaited<ReturnType<typeof issueOrderInTx>>;
  try {
    issued = await tenantTransaction(async (tx) => {
      const res = await issueOrderInTx(tx, { organizationId: input.organizationId, actorUserId: input.actor.id, source: input.source, requestId: input.requestId });
      if (!res.ok) throw new RefusalError(res);
      return res;
    });
  } catch (err) {
    if (err instanceof RefusalError) return err.refusal;
    apiLogger.error({ msg: "procurement/commitments:raise-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not raise the purchase order.", ctx);
  }
  const autoSend = await afterOrderIssued({ organizationId: input.organizationId, actorUserId: input.actor.id, source: input.source, commitmentId: issued.commitmentId });
  const view = await getCommitment(input.organizationId, issued.commitmentId);
  return view.ok ? { ...view, autoSend } : view;
}

/** Carries a refusal out of a transaction so the caller rolls back and returns it as a value. */
class RefusalError extends Error {
  constructor(public readonly refusal: CommitmentRefusal) {
    super(refusal.code);
  }
}

/**
 * The supplier was just approved: every request waiting on it becomes an
 * order, each in its own transaction so one failure never blocks the rest.
 * Called by the supplier service after its own write; failure-isolated.
 */
export async function convertRequestsAwaitingSupplier(input: { organizationId: string; supplierId: string; actorUserId: string; source: Source }): Promise<{ issued: string[]; failed: string[]; sendFailed: number }> {
  const waiting = await db.spendRequest.findMany({ where: { organizationId: input.organizationId, supplierId: input.supplierId, status: "AWAITING_SUPPLIER", linkedCommitmentId: null }, select: { id: true }, orderBy: { createdAt: "asc" } });
  const issued: string[] = [];
  const failed: string[] = [];
  let sendFailed = 0;
  for (const w of waiting) {
    try {
      const res = await tenantTransaction(async (tx) => {
        const out = await issueOrderInTx(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, source: input.source, requestId: w.id });
        if (!out.ok) throw new RefusalError(out);
        return out;
      });
      issued.push(res.commitmentId);
      const sent = await afterOrderIssued({ organizationId: input.organizationId, actorUserId: input.actorUserId, source: input.source, commitmentId: res.commitmentId });
      if (sent.requested && !sent.sent) sendFailed += 1;
    } catch (err) {
      failed.push(w.id);
      apiLogger.error({ msg: "procurement/commitments:convert-on-supplier-approval-failed", err: err instanceof RefusalError ? err.refusal.code : err, requestId: w.id, supplierId: input.supplierId, organizationId: input.organizationId });
    }
  }
  if (waiting.length > 0) apiLogger.info({ msg: "procurement/commitments:converted-on-supplier-approval", supplierId: input.supplierId, issued: issued.length, failed: failed.length, organizationId: input.organizationId });
  return { issued, failed, sendFailed };
}

// ── the PDF and the send ─────────────────────────────────────────────────────

const ORG_SELECT = {
  name: true, logo: true, companyName: true, companyAddress: true, companyCity: true, companyState: true, companyZipCode: true, companyCountry: true, companyPhone: true, companyEmail: true, taxId: true,
} as const;

export async function renderOrderPdf(organizationId: string, commitmentId: string): Promise<{ ok: true; commitmentNo: string; pdf: Buffer } | CommitmentRefusal> {
  const [c, org] = await Promise.all([loadCommitment(db, organizationId, commitmentId), db.organization.findUnique({ where: { id: organizationId }, select: ORG_SELECT })]);
  if (!c || !org) return fail("COMMITMENT_NOT_FOUND", "The purchase order was not found.", { commitmentId });
  const names = await userNames(db, organizationId, [c.spendRequest?.requesterUserId ?? ""]);
  const contact = supplierContactEmails(c.supplier.contacts)[0] ?? null;
  const view = toCommitmentView(c);
  try {
    const pdf = await generatePurchaseOrderPdf({
      commitmentNo: c.commitmentNo,
      issuedAt: c.approvedAt,
      eventName: c.budget?.event?.name ?? null,
      eventCode: c.eventCode,
      requestNo: c.spendRequest?.requestNo ?? null,
      requesterName: c.spendRequest ? (names.get(c.spendRequest.requesterUserId) ?? null) : null,
      currency: c.currency,
      amount: view.amount,
      taxAmount: view.taxAmount,
      lines: view.lines.map((l) => ({ description: l.description, qty: l.qty, unitCost: l.unitCost, amount: l.amount, taxAmount: l.taxAmount, taxRatePercent: l.taxRatePercent, taxCode: l.taxCode })),
      supplier: { code: c.supplier.code, displayName: c.supplier.displayName, legalName: c.supplier.legalName, country: c.supplier.country, paymentTerms: c.supplier.paymentTerms, contactName: contact?.name || null, contactEmail: contact?.email ?? null },
      company: { name: org.name, companyName: org.companyName, address: org.companyAddress, city: org.companyCity, state: org.companyState, zipCode: org.companyZipCode, country: org.companyCountry, phone: org.companyPhone, email: org.companyEmail, taxId: org.taxId, logoPath: org.logo },
    });
    return { ok: true, commitmentNo: c.commitmentNo, pdf };
  } catch (err) {
    apiLogger.error({ msg: "procurement/commitments:pdf-failed", err, commitmentId, organizationId });
    return fail("UNKNOWN", "Could not render the purchase order.", { commitmentId });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Email the PDF to every supplier contact with an address; stamps sentToSupplierAt and audits who sent it and to whom. */
export async function sendOrderToSupplier(input: { organizationId: string; actor: OrderActor; source: Source; commitmentId: string }): Promise<CommitmentResult<CommitmentDetail>> {
  const ctx = { commitmentId: input.commitmentId, userId: input.actor.id };
  const c = await loadCommitment(db, input.organizationId, input.commitmentId);
  if (!c) return fail("COMMITMENT_NOT_FOUND", "The purchase order was not found.", ctx);
  if (!actsOnOrder(input.actor, c.spendRequest?.requesterUserId)) return fail("NOT_ALLOWED", "Only the person who raised the request, the settle holder, or an admin can send the order.", ctx);
  if (c.status !== "APPROVED") return fail("INVALID_STATUS", `A ${COMMITMENT_STATUS_LABEL[c.status as CommitmentStatusValue].toLowerCase()} order is not sent to the supplier.`, ctx, { status: c.status });
  const to = supplierContactEmails(c.supplier.contacts);
  if (to.length === 0) return fail("NO_SUPPLIER_EMAIL", "The supplier has no contact email on the Suppliers page; add one, or send the PDF by hand.", ctx);
  const rendered = await renderOrderPdf(input.organizationId, input.commitmentId);
  if (!rendered.ok) return rendered;
  const org = await db.organization.findUnique({ where: { id: input.organizationId }, select: { name: true, companyName: true } });
  const sender = org?.companyName || org?.name || "Meeting Minds";
  const view = toCommitmentView(c);
  const eventName = c.budget?.event?.name ?? c.eventCode;
  const html = `<p>Dear ${escapeHtml(c.supplier.displayName)},</p>
<p>Please find attached purchase order <strong>${escapeHtml(c.commitmentNo)}</strong> from ${escapeHtml(sender)} for ${escapeHtml(eventName)} (event code ${escapeHtml(c.eventCode)}).</p>
<p>Amount: ${escapeHtml(c.currency)} ${money(view.amount).toFixed(2)} ex-VAT, VAT ${escapeHtml(c.currency)} ${money(view.taxAmount).toFixed(2)}.</p>
<p>Please quote the order number and the event code on your invoice so it can be matched to this order.</p>
<p>Kind regards,<br/>${escapeHtml(sender)}</p>`;
  const text = `Dear ${c.supplier.displayName},\n\nPlease find attached purchase order ${c.commitmentNo} from ${sender} for ${eventName} (event code ${c.eventCode}).\nAmount: ${c.currency} ${money(view.amount).toFixed(2)} ex-VAT, VAT ${c.currency} ${money(view.taxAmount).toFixed(2)}.\nPlease quote the order number and the event code on your invoice.\n\nKind regards,\n${sender}`;
  let result: { success: boolean; error?: string };
  try {
    result = await sendEmail({
      to: to.map((t) => ({ email: t.email, name: t.name || undefined })),
      subject: `Purchase order ${c.commitmentNo} from ${sender}`,
      htmlContent: html,
      textContent: text,
      attachments: [{ name: `${c.commitmentNo}.pdf`, content: rendered.pdf.toString("base64"), contentType: "application/pdf" }],
      emailType: "purchase_order",
      stream: "transactional",
      logContext: { organizationId: input.organizationId, entityType: "OTHER", entityId: c.id, templateSlug: "purchase-order", triggeredByUserId: input.actor.id },
    });
  } catch (err) {
    apiLogger.error({ msg: "procurement/commitments:send-failed", err, ...ctx });
    return fail("SEND_FAILED", "The email could not be sent; nothing about the order changed. Try again, or send the PDF by hand.", ctx);
  }
  if (!result.success) {
    apiLogger.error({ msg: "procurement/commitments:send-failed", error: result.error ?? null, ...ctx });
    return fail("SEND_FAILED", "The email could not be sent; nothing about the order changed. Try again, or send the PDF by hand.", ctx);
  }
  await db.commitment.updateMany({ where: { id: c.id, organizationId: input.organizationId }, data: { sentToSupplierAt: new Date() } });
  await audit(db, { userId: input.actor.id, organizationId: input.organizationId, action: "SEND", entityType: "Commitment", entityId: c.id, changes: { source: input.source, commitmentNo: c.commitmentNo, to: to.map((t) => t.email), supplierId: c.supplierId } });
  apiLogger.info({ msg: "procurement/commitments:sent-to-supplier", recipients: to.length, ...ctx, organizationId: input.organizationId });
  return getCommitment(input.organizationId, c.id);
}

// ── receiving ────────────────────────────────────────────────────────────────

export async function receiveOrder(input: { organizationId: string; actor: OrderActor; source: Source; commitmentId: string; extent: "PARTIAL" | "FULL"; expectedVersion: number }): Promise<CommitmentResult<CommitmentDetail>> {
  const ctx = { commitmentId: input.commitmentId, userId: input.actor.id, extent: input.extent };
  const c = await loadCommitment(db, input.organizationId, input.commitmentId);
  if (!c) return fail("COMMITMENT_NOT_FOUND", "The purchase order was not found.", ctx);
  if (!actsOnOrder(input.actor, c.spendRequest?.requesterUserId)) return fail("NOT_ALLOWED", "Only the person who raised the request, the settle holder, or an admin can mark the order received.", ctx);
  if (c.status !== "APPROVED") return fail("INVALID_STATUS", `A ${COMMITMENT_STATUS_LABEL[c.status as CommitmentStatusValue].toLowerCase()} order cannot be received.`, ctx, { status: c.status });
  if (c.fulfillmentStatus === "RECEIVED") return fail("INVALID_STATUS", "This order is already marked received.", ctx);
  const now = new Date();
  const needsSecond = receiptNeedsSecondPerson(c.spendRequest?.amountAed);
  const data: Prisma.CommitmentUpdateManyMutationInput = input.extent === "FULL"
    ? { fulfillmentStatus: "RECEIVED", receivedAt: now, receivedByUserId: input.actor.id }
    : { fulfillmentStatus: "PARTIALLY_RECEIVED" };
  try {
    await tenantTransaction(async (tx) => {
      const res = await tx.commitment.updateMany({ where: { id: c.id, organizationId: input.organizationId, status: "APPROVED", version: input.expectedVersion }, data: { ...data, version: { increment: 1 } } });
      if (res.count === 0) throw new Error("STALE");
      await audit(tx, { userId: input.actor.id, organizationId: input.organizationId, action: "RECEIVE", entityType: "Commitment", entityId: c.id, changes: { source: input.source, commitmentNo: c.commitmentNo, extent: input.extent, needsSecondPerson: input.extent === "FULL" ? needsSecond : false } });
    });
    return getCommitment(input.organizationId, c.id);
  } catch (err) {
    if ((err as Error).message === "STALE") return fail("STALE_WRITE", "The order changed while you were acting on it. Reload.", ctx);
    apiLogger.error({ msg: "procurement/commitments:receive-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not record the receipt.", ctx);
  }
}

/** The second person of spec §6: the settle holder or an approver, never the one who marked it received. */
export async function confirmReceipt(input: { organizationId: string; actor: OrderActor; source: Source; commitmentId: string; expectedVersion: number }): Promise<CommitmentResult<CommitmentDetail>> {
  const ctx = { commitmentId: input.commitmentId, userId: input.actor.id };
  const [c, actor] = await Promise.all([loadCommitment(db, input.organizationId, input.commitmentId), actorFromRow(input.organizationId, input.actor)]);
  if (!c) return fail("COMMITMENT_NOT_FOUND", "The purchase order was not found.", ctx);
  if (c.status !== "APPROVED") return fail("INVALID_STATUS", `A ${COMMITMENT_STATUS_LABEL[c.status as CommitmentStatusValue].toLowerCase()} order's receipt is not confirmed.`, ctx, { status: c.status });
  if (c.fulfillmentStatus !== "RECEIVED" || c.receivedByUserId === null) return fail("INVALID_STATUS", "The order has not been marked fully received yet.", ctx, { fulfillmentStatus: c.fulfillmentStatus });
  if (c.receiptConfirmedAt) return fail("INVALID_STATUS", "This receipt is already confirmed.", ctx);
  if (!receiptNeedsSecondPerson(c.spendRequest?.amountAed)) return fail("INVALID_STATUS", "This order is below the second-person floor; its receipt needs no confirmation.", ctx);
  if (!(actor.canSettle || actor.canApprove)) return fail("NOT_ALLOWED", "The second person is the settle holder or an approver.", ctx);
  if (input.actor.id === c.receivedByUserId) return fail("NOT_ALLOWED", "The person who marked the order received cannot confirm it; a second person must.", ctx);
  try {
    await tenantTransaction(async (tx) => {
      const res = await tx.commitment.updateMany({ where: { id: c.id, organizationId: input.organizationId, status: "APPROVED", fulfillmentStatus: "RECEIVED", receiptConfirmedAt: null, version: input.expectedVersion }, data: { receiptConfirmedAt: new Date(), receiptConfirmedByUserId: input.actor.id, version: { increment: 1 } } });
      if (res.count === 0) throw new Error("STALE");
      await audit(tx, { userId: input.actor.id, organizationId: input.organizationId, action: "CONFIRM_RECEIPT", entityType: "Commitment", entityId: c.id, changes: { source: input.source, commitmentNo: c.commitmentNo, receivedByUserId: c.receivedByUserId, amountAed: s4(c.spendRequest?.amountAed) } });
    });
    return getCommitment(input.organizationId, c.id);
  } catch (err) {
    if ((err as Error).message === "STALE") return fail("STALE_WRITE", "The order changed while you were acting on it. Reload.", ctx);
    apiLogger.error({ msg: "procurement/commitments:confirm-receipt-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not confirm the receipt.", ctx);
  }
}

// ── cancel ───────────────────────────────────────────────────────────────────

/**
 * Cancel is close-and-release (spec §6): the order is cancelled, the line's
 * committed figures fall by what it held, and the request goes back to its
 * approver for a fresh decision (owner decision, 15 September 2026), so the
 * requester cannot undo the cancel by raising a new order alone; on approval
 * a new order is issued. When nobody can take it any more it returns to draft.
 * The settle holder's or an admin's action, with a reason. Only an order
 * with nothing received is cancelled: once goods or services have arrived,
 * the money is owed and the order is closed against the supplier's invoice.
 */
export async function cancelOrder(input: { organizationId: string; actor: OrderActor; source: Source; commitmentId: string; reason: string | null | undefined; expectedVersion: number }): Promise<CommitmentResult<CommitmentDetail> & { reroute?: RerouteOutcome | null }> {
  const ctx = { commitmentId: input.commitmentId, userId: input.actor.id };
  const [c, actor] = await Promise.all([loadCommitment(db, input.organizationId, input.commitmentId), actorFromRow(input.organizationId, input.actor)]);
  if (!c) return fail("COMMITMENT_NOT_FOUND", "The purchase order was not found.", ctx);
  if (!(actor.canSettle || actor.isAdmin)) return fail("NOT_ALLOWED", "Only the settle holder or an admin cancels a purchase order.", ctx);
  if (c.status !== "APPROVED") return fail("INVALID_STATUS", `A ${COMMITMENT_STATUS_LABEL[c.status as CommitmentStatusValue].toLowerCase()} order cannot be cancelled.`, ctx, { status: c.status });
  if (c.fulfillmentStatus !== "OPEN") return fail("INVALID_STATUS", "Part or all of this order has been received, so it can no longer be cancelled. A received order is closed against the supplier's invoice.", ctx, { fulfillmentStatus: c.fulfillmentStatus });
  const reason = input.reason?.trim() || null;
  if (!reason) return fail("REASON_REQUIRED", "Give the reason for cancelling the order.", ctx);
  const amountReporting = toReporting(c.amount, money(c.fxRateToReporting));
  let reroute: RerouteOutcome | null = null;
  try {
    await tenantTransaction(async (tx) => {
      // A closed-out budget's figures are the signed-off record: a cancel would re-sum a line on it.
      if (c.budgetId && (await eventBudgetClosed(tx, input.organizationId, c.budgetId))) throw new Error("BUDGET_CLOSED");
      const res = await tx.commitment.updateMany({ where: { id: c.id, organizationId: input.organizationId, status: "APPROVED", fulfillmentStatus: "OPEN", version: input.expectedVersion }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledByUserId: input.actor.id, cancelReason: reason, version: { increment: 1 } } });
      if (res.count === 0) throw new Error("STALE");
      if (c.budgetId) {
        // Released on the event's current version, summed from the orders that are left.
        const committedOn = await syncLineCommitted(tx, { organizationId: input.organizationId, budgetId: c.budgetId, lineKey: c.lineKey });
        await recomputeBudgetTotals(tx, committedOn ?? c.budgetId);
      }
      if (c.spendRequestId) {
        // After the release above, so the fresh budget check sees the order's money as free again.
        const outcome = await rerouteAfterOrderCancelInTx(tx, { organizationId: input.organizationId, requestId: c.spendRequestId, commitmentId: c.id, commitmentNo: c.commitmentNo, cancelReason: reason, source: input.source });
        reroute = outcome;
        await audit(tx, { userId: input.actor.id, organizationId: input.organizationId, action: "ORDER_CANCELLED", entityType: "SpendRequest", entityId: c.spendRequestId, changes: { source: input.source, commitmentNo: c.commitmentNo, commitmentId: c.id, reason, requestNow: outcome.status, approvalRequestId: outcome.status === "PENDING_APPROVAL" ? outcome.approvalRequestId : null } });
      }
      await audit(tx, { userId: input.actor.id, organizationId: input.organizationId, action: "CANCEL", entityType: "Commitment", entityId: c.id, changes: { source: input.source, commitmentNo: c.commitmentNo, reason, released: storedString(amountReporting), budgetId: c.budgetId, lineKey: c.lineKey } });
    });
    apiLogger.info({ msg: "procurement/commitments:cancelled", requestNow: (reroute as RerouteOutcome | null)?.status ?? null, ...ctx, organizationId: input.organizationId });
    const view = await getCommitment(input.organizationId, c.id);
    return view.ok ? { ...view, reroute } : view;
  } catch (err) {
    if ((err as Error).message === "STALE") return fail("STALE_WRITE", "The order changed while you were acting on it. Reload.", ctx);
    if ((err as Error).message === "BUDGET_CLOSED") return fail("BUDGET_CLOSED", "The event's budget is closed out, so its figures are final and the order cannot be cancelled. An admin can reopen the budget first.", ctx);
    apiLogger.error({ msg: "procurement/commitments:cancel-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not cancel the purchase order.", ctx);
  }
}
