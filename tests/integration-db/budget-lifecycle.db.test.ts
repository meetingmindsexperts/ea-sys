/**
 * Adversarial test P2 (Oct 28, 2026), on a REAL Postgres through the real
 * services: one budget taken through rejection, resubmission, approval, a new
 * version, freeze, unfreeze, close, sign-off and reopen. After every step the
 * status, the totals, the approval requests and the audit trail must agree.
 *
 * Invariants checked throughout:
 *   - the planned total is the sum of the live non-contingency lines, and the
 *     contingency is the percent of it;
 *   - at most one approval request per budget is PENDING, and it is priced at
 *     the planned total as it stands;
 *   - at most one version of the event is ACTIVE or FROZEN;
 *   - every transition left exactly one audit row of its action.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import * as budgets from "@/procurement/services/budget-service";
import { resetCrm } from "./helper";

let orgId: string;
let owner: string;
let approver: { id: string; role: string; organizationId: string; procurementApproveUnlimited: boolean; procurementApproveCeilingAed: null };
let eventId: string;
const base = () => ({ organizationId: orgId, actorUserId: owner, source: "ui" as const });
const inOrg = <T,>(f: () => Promise<T>) => runWithTenant(orgId, f);

async function budgetRow(id: string) {
  return db.eventBudget.findUniqueOrThrow({ where: { id }, select: { status: true, version: true, plannedExpenseTotal: true, contingencyAmount: true, contingencyPercent: true, submittedAt: true, approvedAt: true, closedAt: true, signedOffAt: true } });
}

/** The invariants that must hold after every step, whatever the step was. */
async function assertConsistent(budgetId: string) {
  const b = await budgetRow(budgetId);
  const lines = await db.budgetLine.findMany({ where: { budgetId, deletedAt: null, isContingency: false }, select: { planned: true } });
  const sum = lines.reduce((s, l) => s + Number(l.planned), 0);
  expect(Number(b.plannedExpenseTotal), "planned total = sum of the live lines").toBeCloseTo(sum, 4);
  expect(Number(b.contingencyAmount), "contingency = percent of planned").toBeCloseTo((sum * Number(b.contingencyPercent)) / 100, 4);
  const pending = await db.approvalRequest.findMany({ where: { subjectType: "BUDGET", subjectId: budgetId, status: "PENDING" }, select: { amount: true } });
  expect(pending.length, "at most one pending approval").toBeLessThanOrEqual(1);
  if (b.status === "UNDER_REVIEW") {
    expect(pending.length, "under review means one pending approval").toBe(1);
    expect(Number(pending[0].amount), "the pending approval is priced at the plan as it stands").toBeCloseTo(sum, 4);
  }
  if (b.status !== "UNDER_REVIEW") expect(pending.length, "only a budget under review has a pending approval").toBe(0);
  const current = await db.eventBudget.count({ where: { eventId, status: { in: ["ACTIVE", "FROZEN"] } } });
  expect(current, "at most one current version per event").toBeLessThanOrEqual(1);
  return b;
}

const actions = async (budgetId: string) =>
  (await db.auditLog.findMany({ where: { entityType: "EventBudget", entityId: budgetId }, orderBy: { createdAt: "asc" }, select: { action: true } })).map((r) => r.action);

async function markRestNotApplicable(budgetId: string) {
  const covered = new Set((await db.budgetLine.findMany({ where: { budgetId, deletedAt: null, isContingency: false }, select: { category: { select: { code: true } } } })).map((l) => l.category.code));
  const codes = (await db.budgetCategory.findMany({ where: { organizationId: orgId, isActive: true, type: "EXPENSE", depth: 0 }, select: { code: true } })).map((c) => c.code).filter((c) => c !== "CONTINGENCY" && !covered.has(c));
  const r = await inOrg(async () => budgets.updateBudgetHeader({ ...base(), budgetId, expectedVersion: (await budgetRow(budgetId)).version, naCategoryCodes: codes, expectedAttendance: 200 }));
  expect(r.ok).toBe(true);
}

async function addLine(budgetId: string, code: string, unitCost: number) {
  const categoryId = (await db.budgetCategory.findFirstOrThrow({ where: { organizationId: orgId, code }, select: { id: true } })).id;
  const r = await inOrg(() => budgets.upsertBudgetLine({ ...base(), budgetId, categoryId, description: `${code} line`, qty: 1, unitCost }));
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

const decide = (budgetId: string, decision: "APPROVED" | "REJECTED") => inOrg(() => budgets.decideBudget({ organizationId: orgId, decider: approver as never, source: "ui", budgetId, decision, note: decision === "REJECTED" ? "too high" : null }));

beforeAll(async () => {
  const seed = await resetCrm();
  orgId = seed.orgId;
  owner = seed.userId;
  const a = await db.user.create({ data: { organizationId: orgId, email: `approver-${Date.now()}@test.local`, passwordHash: "x", firstName: "Ann", lastName: "Prover", role: "ADMIN", procurementApproveUnlimited: true }, select: { id: true } });
  approver = { id: a.id, role: "ADMIN", organizationId: orgId, procurementApproveUnlimited: true, procurementApproveCeilingAed: null };
  eventId = (await db.event.create({ data: { organizationId: orgId, name: "Lifecycle congress", code: "LIFE26", slug: `life-${Date.now()}`, startDate: new Date("2026-12-01"), endDate: new Date("2026-12-02") }, select: { id: true } })).id;
}, 120_000);

describe("a budget's lifecycle stays consistent end to end (P2)", () => {
  let v1: string;
  let v2: string;

  it("creates a draft, plans it and submits it at the planned total", async () => {
    const created = await inOrg(() => budgets.createBudget({ ...base(), eventId, reportingCurrency: "AED", contingencyPercent: 5 }));
    if (!created.ok) throw new Error(created.code);
    v1 = created.budget.id;
    await addLine(v1, "510300", 1000);
    await addLine(v1, "510400", 2000);
    await markRestNotApplicable(v1);
    expect((await assertConsistent(v1)).status).toBe("DRAFT");
    const s = await inOrg(() => budgets.submitBudget({ ...base(), budgetId: v1 }));
    expect(s.ok, JSON.stringify(s)).toBe(true);
    const b = await assertConsistent(v1);
    expect(b.status).toBe("UNDER_REVIEW");
    expect(Number(b.plannedExpenseTotal)).toBe(3000);
  });

  it("refuses a planned edit while under review, and the rejection returns it to a draft", async () => {
    const line = await db.budgetLine.findFirstOrThrow({ where: { budgetId: v1, isContingency: false }, select: { id: true } });
    expect(await inOrg(() => budgets.upsertBudgetLine({ ...base(), budgetId: v1, lineId: line.id, unitCost: 9999 }))).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    const r = await decide(v1, "REJECTED");
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((await assertConsistent(v1)).status).toBe("DRAFT");
    expect(await db.approvalRequest.count({ where: { subjectId: v1, status: "REJECTED" } })).toBe(1);
  });

  it("is revised and resubmitted at the new total, then approved and activated", async () => {
    const venue = await db.budgetLine.findFirstOrThrow({ where: { budgetId: v1, description: "510400 line" }, select: { id: true } });
    expect((await inOrg(() => budgets.upsertBudgetLine({ ...base(), budgetId: v1, lineId: venue.id, unitCost: 2500 }))).ok).toBe(true);
    expect((await inOrg(() => budgets.submitBudget({ ...base(), budgetId: v1 }))).ok).toBe(true);
    expect(Number((await assertConsistent(v1)).plannedExpenseTotal)).toBe(3500);
    const r = await decide(v1, "APPROVED");
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const b = await assertConsistent(v1);
    expect(b.status).toBe("ACTIVE");
    expect(b.approvedAt).not.toBeNull();
    const lines = await db.budgetLine.findMany({ where: { budgetId: v1, isContingency: false }, select: { planned: true, approvedPlanned: true } });
    for (const l of lines) expect(Number(l.approvedPlanned)).toBe(Number(l.planned));
    expect(await db.approvalRequest.count({ where: { subjectId: v1 } })).toBe(2);
  });

  it("clones a new version with the same line keys, and approving it archives the first", async () => {
    const n = await inOrg(() => budgets.newBudgetVersion({ ...base(), budgetId: v1 }));
    if (!n.ok) throw new Error(n.code);
    v2 = n.budget.id;
    const keys = async (id: string) => (await db.budgetLine.findMany({ where: { budgetId: id, deletedAt: null }, select: { lineKey: true }, orderBy: { lineKey: "asc" } })).map((l) => l.lineKey);
    expect(await keys(v2)).toEqual(await keys(v1));
    expect((await assertConsistent(v2)).status).toBe("DRAFT");
    expect((await budgetRow(v1)).status).toBe("ACTIVE");
    const av = await db.budgetLine.findFirstOrThrow({ where: { budgetId: v2, description: "510300 line" }, select: { id: true } });
    expect((await inOrg(() => budgets.upsertBudgetLine({ ...base(), budgetId: v2, lineId: av.id, unitCost: 1200 }))).ok).toBe(true);
    expect((await inOrg(() => budgets.submitBudget({ ...base(), budgetId: v2 }))).ok).toBe(true);
    expect((await decide(v2, "APPROVED")).ok).toBe(true);
    expect((await assertConsistent(v2)).status).toBe("ACTIVE");
    expect((await budgetRow(v1)).status).toBe("ARCHIVED");
    expect(Number((await budgetRow(v2)).plannedExpenseTotal)).toBe(3700);
  });

  it("freezes (planned edits refused), unfreezes with a reason, closes, signs off and reopens", async () => {
    expect((await inOrg(() => budgets.freezeBudget({ ...base(), budgetId: v2 }))).ok).toBe(true);
    expect((await assertConsistent(v2)).status).toBe("FROZEN");
    const line = await db.budgetLine.findFirstOrThrow({ where: { budgetId: v2, isContingency: false }, select: { id: true } });
    expect(await inOrg(() => budgets.upsertBudgetLine({ ...base(), budgetId: v2, lineId: line.id, unitCost: 1 }))).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    expect(await inOrg(() => budgets.unfreezeBudget({ ...base(), budgetId: v2, reason: "  " }))).toMatchObject({ ok: false, code: "INVALID_AMOUNT" });
    expect((await inOrg(() => budgets.unfreezeBudget({ ...base(), budgetId: v2, reason: "supplier moved dates" }))).ok).toBe(true);
    expect((await assertConsistent(v2)).status).toBe("ACTIVE");

    // Nothing was spent, so every line differs from plan: the close asks for its variance notes first.
    let closed = await inOrg(() => budgets.closeBudget({ ...base(), budgetId: v2 }));
    if (!closed.ok && closed.code === "VARIANCE_NOTES_REQUIRED") {
      const lineKeys = (closed.meta?.lineKeys as string[]) ?? [];
      closed = await inOrg(() => budgets.closeBudget({ ...base(), budgetId: v2, varianceNotes: Object.fromEntries(lineKeys.map((k) => [k, "Not spent: test event"])) }));
    }
    expect(closed.ok, JSON.stringify(closed)).toBe(true);
    expect((await assertConsistent(v2)).status).toBe("CLOSED");
    expect((await inOrg(() => budgets.signOffBudget({ ...base(), budgetId: v2 }))).ok).toBe(true);
    expect((await budgetRow(v2)).signedOffAt).not.toBeNull();

    expect((await inOrg(() => budgets.reopenBudget({ ...base(), budgetId: v2, reason: "late invoice" }))).ok).toBe(true);
    const reopened = await assertConsistent(v2);
    expect(reopened.status).toBe("ACTIVE");
    expect(reopened.closedAt).toBeNull();
    expect(reopened.signedOffAt).toBeNull();
  });

  it("left an audit trail with one row per transition, in order", async () => {
    expect(await actions(v1)).toEqual(["CREATE", "UPDATE", "SUBMIT", "REJECT", "SUBMIT", "APPROVE"]);
    expect(await actions(v2)).toEqual(["NEW_VERSION", "SUBMIT", "APPROVE", "FREEZE", "UNFREEZE", "CLOSE", "SIGN_OFF", "REOPEN"]);
    // Each submit opens a request and each decision closes it: three of each, paired in order.
    const decisions = await db.auditLog.findMany({ where: { entityType: "ApprovalRequest", organizationId: orgId }, orderBy: { createdAt: "asc" }, select: { action: true } });
    expect(decisions.map((d) => d.action)).toEqual(["APPROVAL_REQUESTED", "APPROVAL_REJECTED", "APPROVAL_REQUESTED", "APPROVAL_GRANTED", "APPROVAL_REQUESTED", "APPROVAL_GRANTED"]);
  });
});
