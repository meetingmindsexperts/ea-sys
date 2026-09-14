/**
 * GET the approval inbox: requests waiting on the caller (assignee or
 * delegate of a pending step), the caller's own requests, or what the caller
 * has decided (approved or rejected), newest first.
 * Every row names its subject (the budget's event code and version, or the
 * spend request's number, title and line) so the inbox reads without a
 * second call.
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { requiresFinalApprover } from "@/lib/approvals/approvals-service";
import { guardedRead, procurementGuard } from "@/procurement/lib/route-helpers";
import { readApprovalPayload } from "@/procurement/services/spend-request-service";

type Move = { fromLineKey: string; toLineKey: string; amount: string };
/** The move a reallocation request carries (written by reallocateBudget); anything else reads as no move. */
function readMove(payload: unknown): Move | null {
  const p = payload as Partial<Move> | null;
  return p && typeof p.fromLineKey === "string" && typeof p.toLineKey === "string" && typeof p.amount === "string" ? { fromLineKey: p.fromLineKey, toLineKey: p.toLineKey, amount: p.amount } : null;
}

export async function GET(req: NextRequest) {
  const g = await procurementGuard({ route: "procurement/approvals", need: "view" });
  if (!g.ok) return g.response;
  const raw = req.nextUrl.searchParams.get("scope");
  const scope = raw === "mine" ? "mine" : raw === "decided" ? "decided" : "inbox";
  return runWithTenant(g.orgId, () => guardedRead("procurement/approvals", g.user.id, async () => {
    const requests = await db.approvalRequest.findMany({
      where: {
        organizationId: g.orgId,
        ...(scope === "mine"
          ? { requesterUserId: g.user.id }
          : scope === "decided"
            ? { status: { in: ["APPROVED", "REJECTED"] }, steps: { some: { decidedByUserId: g.user.id } } }
            : { status: "PENDING", steps: { some: { status: "PENDING", OR: [{ assigneeUserId: g.user.id }, { delegateUserId: g.user.id }] } } }),
      },
      select: {
        id: true, subjectType: true, subjectId: true, amountAed: true, amount: true, currency: true, status: true, requesterUserId: true, reason: true, payload: true, decidedAt: true, createdAt: true,
        steps: { select: { id: true, sequence: true, assigneeUserId: true, delegateUserId: true, dueAt: true, status: true, decidedByUserId: true, decidedAt: true, note: true }, orderBy: { sequence: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    // A spend request's subject is the request; its budget is read off the row.
    const spendRequestIds = [...new Set(requests.filter((r) => r.subjectType === "SPEND_REQUEST").map((r) => r.subjectId))];
    const spendRequests = spendRequestIds.length
      ? await db.spendRequest.findMany({
          where: { id: { in: spendRequestIds }, organizationId: g.orgId },
          select: { id: true, requestNo: true, title: true, status: true, budgetCheckStatus: true, budgetId: true, lineKey: true, eventCode: true, supplierId: true, proposedVendorName: true, supplier: { select: { displayName: true, approvalStatus: true } } },
        })
      : [];
    const bySpendRequest = new Map(spendRequests.map((s) => [s.id, s]));
    const budgetIds = [...new Set([...requests.filter((r) => r.subjectType !== "SPEND_REQUEST").map((r) => r.subjectId), ...spendRequests.flatMap((s) => (s.budgetId ? [s.budgetId] : []))])];
    const budgets = budgetIds.length
      ? await db.eventBudget.findMany({ where: { id: { in: budgetIds }, organizationId: g.orgId }, select: { id: true, eventCode: true, versionNo: true, status: true, reportingCurrency: true, event: { select: { name: true } } } })
      : [];
    const userIds = [...new Set(requests.flatMap((r) => [r.requesterUserId, ...r.steps.map((s) => s.assigneeUserId)]))];
    const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds }, organizationId: g.orgId }, select: { id: true, firstName: true, lastName: true } }) : [];
    const byBudget = new Map(budgets.map((b) => [b.id, b]));
    const byUser = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
    // A reallocation names its two lines by key; the inbox should read the
    // lines' words, not their keys, so the descriptions ride along.
    const moves = requests.flatMap((r) => (r.subjectType === "BUDGET_REALLOCATION" ? [readMove(r.payload)].filter((m): m is Move => m !== null).map((m) => ({ budgetId: r.subjectId, ...m })) : []));
    const requestLines = spendRequests.flatMap((s) => (s.budgetId && s.lineKey ? [{ budgetId: s.budgetId, lineKey: s.lineKey }] : []));
    const lineLookups = [...moves.flatMap((m) => [{ budgetId: m.budgetId, lineKey: m.fromLineKey }, { budgetId: m.budgetId, lineKey: m.toLineKey }]), ...requestLines];
    const lineRows = lineLookups.length
      ? await db.budgetLine.findMany({
          where: { organizationId: g.orgId, OR: lineLookups },
          select: { budgetId: true, lineKey: true, description: true },
        })
      : [];
    const lineDescription = new Map(lineRows.map((l) => [`${l.budgetId}:${l.lineKey}`, l.description]));
    return NextResponse.json({
      scope,
      requests: requests.map((r) => {
        const move = r.subjectType === "BUDGET_REALLOCATION" ? readMove(r.payload) : null;
        const sr = r.subjectType === "SPEND_REQUEST" ? bySpendRequest.get(r.subjectId) : undefined;
        const payload = sr ? readApprovalPayload(r.payload) : null;
        return {
          ...r,
          amountAed: r.amountAed.toString(),
          amount: r.amount?.toString() ?? null,
          requesterName: byUser.get(r.requesterUserId) ?? null,
          budget: byBudget.get(sr ? (sr.budgetId ?? "") : r.subjectId) ?? null,
          spendRequest: sr
            ? {
                id: sr.id,
                requestNo: sr.requestNo,
                title: sr.title,
                status: sr.status,
                budgetCheckStatus: sr.budgetCheckStatus,
                lineKey: sr.lineKey,
                lineDescription: sr.budgetId && sr.lineKey ? (lineDescription.get(`${sr.budgetId}:${sr.lineKey}`) ?? null) : null,
                vendor: sr.supplier?.displayName ?? sr.proposedVendorName ?? null,
                supplierApproved: sr.supplier?.approvalStatus === "APPROVED",
                exception: requiresFinalApprover(r.payload),
                kind: payload?.kind ?? null,
                amendment: payload?.kind === "AMENDMENT" ? { previousAmount: payload.previousAmount, nextAmount: payload.nextAmount, deltaReporting: payload.deltaReporting, reason: payload.reason } : null,
                remainingAfter: payload?.kind === "SUBMISSION" ? payload.remainingAfter : null,
              }
            : null,
          move: move
            ? { ...move, fromDescription: lineDescription.get(`${r.subjectId}:${move.fromLineKey}`) ?? null, toDescription: lineDescription.get(`${r.subjectId}:${move.toLineKey}`) ?? null }
            : null,
          steps: r.steps.map((s) => ({ ...s, assigneeName: byUser.get(s.assigneeUserId) ?? null })),
        };
      }),
    });
  }));
}
