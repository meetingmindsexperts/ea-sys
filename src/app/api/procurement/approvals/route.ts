/**
 * GET the approval inbox: requests waiting on the caller (assignee or
 * delegate of a pending step), plus the caller's own requests, newest first.
 * Every row names its subject (the budget's event code and version) so the
 * inbox reads without a second call.
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { guardedRead, procurementGuard } from "@/procurement/lib/route-helpers";

export async function GET(req: NextRequest) {
  const g = await procurementGuard({ route: "procurement/approvals", need: "view" });
  if (!g.ok) return g.response;
  const scope = req.nextUrl.searchParams.get("scope") === "mine" ? "mine" : "inbox";
  return runWithTenant(g.orgId, () => guardedRead("procurement/approvals", g.user.id, async () => {
    const requests = await db.approvalRequest.findMany({
      where: {
        organizationId: g.orgId,
        ...(scope === "mine"
          ? { requesterUserId: g.user.id }
          : { status: "PENDING", steps: { some: { status: "PENDING", OR: [{ assigneeUserId: g.user.id }, { delegateUserId: g.user.id }] } } }),
      },
      select: {
        id: true, subjectType: true, subjectId: true, amountAed: true, amount: true, currency: true, status: true, requesterUserId: true, reason: true, payload: true, decidedAt: true, createdAt: true,
        steps: { select: { id: true, sequence: true, assigneeUserId: true, delegateUserId: true, dueAt: true, status: true, decidedByUserId: true, decidedAt: true, note: true }, orderBy: { sequence: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const budgetIds = [...new Set(requests.map((r) => r.subjectId))];
    const budgets = budgetIds.length
      ? await db.eventBudget.findMany({ where: { id: { in: budgetIds }, organizationId: g.orgId }, select: { id: true, eventCode: true, versionNo: true, status: true, reportingCurrency: true, event: { select: { name: true } } } })
      : [];
    const userIds = [...new Set(requests.flatMap((r) => [r.requesterUserId, ...r.steps.map((s) => s.assigneeUserId)]))];
    const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds }, organizationId: g.orgId }, select: { id: true, firstName: true, lastName: true } }) : [];
    const byBudget = new Map(budgets.map((b) => [b.id, b]));
    const byUser = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
    return NextResponse.json({
      scope,
      requests: requests.map((r) => ({
        ...r,
        amountAed: r.amountAed.toString(),
        amount: r.amount?.toString() ?? null,
        requesterName: byUser.get(r.requesterUserId) ?? null,
        budget: byBudget.get(r.subjectId) ?? null,
        steps: r.steps.map((s) => ({ ...s, assigneeName: byUser.get(s.assigneeUserId) ?? null })),
      })),
    });
  }));
}
