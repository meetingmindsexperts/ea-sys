/**
 * A cancelled purchase order sends its request back to the approver (owner
 * decision, 15 September 2026): the settle holder's cancel cannot be undone
 * by the requester raising a new order alone. Runs inside the cancel's own
 * transaction, after the order's amount was released on the line, so the
 * fresh budget check sees that money as free again.
 *
 * The request is routed again on what it was submitted with: its amount, its
 * request-to-reporting rate and its AED figure, through the same matrix and
 * the same exception rule as a submit, with the line's other open requests
 * counted as taken. The cancel's reason travels as the approval's reason.
 * When nobody can take the request any more (no grant covers the amount, or
 * its budget version no longer takes requests), it goes back to draft
 * instead, so nothing can be ordered without a new decision.
 *
 * Imports no procurement service (commitment-service calls this), so the
 * graph has no cycle; the payload type is a type-only import.
 */
import { apiLogger } from "@/lib/logger";
import { createApprovalRequest, type Db } from "@/lib/approvals/approvals-service";
import { money, storedString } from "../lib/money";
import { OPEN_REQUEST_STATUSES, budgetAcceptsRequests, budgetCheck, reservedOnLine, toReporting } from "../lib/spend-request-rules";
import { lockEventCommitted } from "./committed-figures";
import type { SubmissionPayload } from "./spend-request-service";

type Source = "ui" | "mcp";

export type RerouteOutcome =
  | { status: "PENDING_APPROVAL"; approvalRequestId: string; exception: boolean }
  | { status: "DRAFT"; reason: string }
  | { status: "UNCHANGED" };

export async function rerouteAfterOrderCancelInTx(
  tx: Db,
  input: { organizationId: string; requestId: string; commitmentId: string; commitmentNo: string; cancelReason: string; source: Source },
): Promise<RerouteOutcome> {
  const ctx = { requestId: input.requestId, commitmentId: input.commitmentId, organizationId: input.organizationId };
  const r = await tx.spendRequest.findFirst({
    where: { id: input.requestId, organizationId: input.organizationId },
    select: { id: true, requestNo: true, requesterUserId: true, budgetId: true, lineKey: true, amount: true, currency: true, fxRateToReporting: true, amountAed: true, status: true, linkedCommitmentId: true },
  });
  if (!r || r.status !== "CONVERTED" || r.linkedCommitmentId !== input.commitmentId) {
    apiLogger.warn({ msg: "procurement/requests:reroute-skipped", status: r?.status ?? null, ...ctx });
    return { status: "UNCHANGED" };
  }
  const claimed = { id: r.id, organizationId: input.organizationId, status: "CONVERTED" as const, linkedCommitmentId: input.commitmentId };
  const toDraft = async (why: string): Promise<RerouteOutcome> => {
    const res = await tx.spendRequest.updateMany({ where: claimed, data: { status: "DRAFT", linkedCommitmentId: null, approvalRequestId: null, budgetCheckStatus: "NOT_CHECKED", submittedAt: null, decidedAt: null, decidedByUserId: null, decisionNote: null, version: { increment: 1 } } });
    if (res.count === 0) throw new Error("STALE");
    apiLogger.warn({ msg: "procurement/requests:reroute-to-draft", why, ...ctx });
    return { status: "DRAFT", reason: why };
  };

  if (!r.budgetId || !r.lineKey || r.fxRateToReporting === null || r.amountAed === null) return toDraft("The request carries no line, rate or AED amount to route on.");
  const budget = await tx.eventBudget.findFirst({ where: { id: r.budgetId, organizationId: input.organizationId }, select: { id: true, status: true, reportingCurrency: true } });
  if (!budget || !budgetAcceptsRequests(budget.status)) return toDraft("The budget version the request was raised on no longer takes requests.");
  const line = await tx.budgetLine.findFirst({ where: { budgetId: budget.id, lineKey: r.lineKey, deletedAt: null }, select: { lineKey: true, planned: true, committedOpen: true, actual: true } });
  if (!line) return toDraft("The request's line is no longer on its budget version.");

  // The cancel already holds this lock (it released the line under it); taking it again is a no-op.
  const locked = await lockEventCommitted(tx, input.organizationId, budget.id);
  const versionIds = locked?.versions.map((v) => v.id) ?? [budget.id];
  const others = await tx.spendRequest.findMany({
    where: { organizationId: input.organizationId, budgetId: { in: versionIds }, lineKey: r.lineKey, id: { not: r.id }, status: { in: [...OPEN_REQUEST_STATUSES] } },
    select: { status: true, linkedCommitmentId: true, amount: true, fxRateToReporting: true },
  });
  const amountReporting = toReporting(r.amount, r.fxRateToReporting);
  const check = budgetCheck({ budgetStatus: budget.status, line, amountReporting, reservedByOthers: reservedOnLine(others) });
  const reportingToAedRate = amountReporting.gt(0) ? money(r.amountAed).div(amountReporting).toDecimalPlaces(8) : money(1);
  const payload: SubmissionPayload = {
    kind: "SUBMISSION",
    budgetId: budget.id,
    lineKey: r.lineKey,
    budgetCheck: check.status,
    amountReporting: storedString(amountReporting),
    remainingBefore: storedString(check.remainingBefore),
    remainingAfter: storedString(check.remainingAfter),
    reportingCurrency: budget.reportingCurrency,
    requestToReportingRate: money(r.fxRateToReporting).toString(),
    reportingToAedRate: reportingToAedRate.toString(),
    rateSource: "stored",
  };
  const reason = `Order ${input.commitmentNo} was cancelled: ${input.cancelReason}`;
  const approval = await createApprovalRequest(tx, {
    organizationId: input.organizationId,
    subjectType: "SPEND_REQUEST",
    subjectId: r.id,
    amountAed: Number(storedString(r.amountAed)),
    amount: storedString(r.amount),
    currency: r.currency,
    requesterUserId: r.requesterUserId,
    reason,
    payload,
    requireFinalApprover: check.exception,
    source: input.source,
  });
  if (!approval.ok) return toDraft(approval.message);
  const res = await tx.spendRequest.updateMany({
    where: claimed,
    data: { status: "PENDING_APPROVAL", linkedCommitmentId: null, approvalRequestId: approval.request.id, budgetCheckStatus: check.status, submittedAt: new Date(), decidedAt: null, decidedByUserId: null, decisionNote: null, version: { increment: 1 } },
  });
  // A lost claim rolls the whole cancel back (the caller maps STALE), so no approval is left behind.
  if (res.count === 0) throw new Error("STALE");
  apiLogger.info({ msg: "procurement/requests:rerouted-after-cancel", budgetCheck: check.status, exception: check.exception, approvalRequestId: approval.request.id, ...ctx });
  return { status: "PENDING_APPROVAL", approvalRequestId: approval.request.id, exception: check.exception };
}
