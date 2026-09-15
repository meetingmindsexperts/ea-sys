/**
 * The approvals primitive's inaction half (spec §8.3): the assignment email,
 * the reminder, the delegate at 48 hours, the escalation at 96 hours, and the
 * decision emailed back to the requester. One tick, run by the
 * `approval-escalation` worker job; the timeline itself is pure and lives in
 * `escalation-rules.ts`, the wording in `approval-emails.ts`.
 *
 * WHY A WORKER AND NOT A SEND AT SUBMIT. A request is created inside its
 * caller's transaction (a budget submit, a reallocation, a spend request, an
 * amount change), four call sites. An email sent from each would be four
 * copies of the same fan-out and would go out for a transaction that then
 * rolled back. The worker reads committed rows only, is the one place the
 * sends live, and survives a crash between commit and send.
 *
 * IDEMPOTENCY. Every action is a CONDITIONAL CLAIM on the row before its
 * email (`notifiedAt` null, `remindedAt` as observed, `delegateUserId` null,
 * `escalatedAt` null, `decisionNotifiedAt` null), the CRM reminders pattern:
 * a second tick, or a second worker mid-failover, gets zero rows and skips.
 * A send that fails after its claim is logged at error and NOT retried: a
 * retry risks a duplicate for a failure that delivered, and the approver
 * still sees the request on the Approvals page and gets the next reminder.
 *
 * BOUNDED. Assignment and decision emails go out only for rows newer than
 * NOTIFY_WINDOW_DAYS, so a worker that was down for a week does not mail old
 * news, and the migration stamped every existing row as already notified.
 *
 * TENANCY. The two scans run on the privileged lane (they find work across
 * every tenant); every read, claim, audit row and send after that runs inside
 * the row's own tenant lane on the normal client.
 */
import { db, dbOperator, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { sendEmail } from "@/lib/email";
import { isProcurementModuleEnabled } from "@/lib/module-flags";
import { approvalCeilingAed, procurementGrantsFromRow } from "@/lib/procurement-visibility";
import { DEFAULT_STEP_DUE_HOURS, requiresFinalApprover } from "./approvals-service";
import { NOTIFY_WINDOW_DAYS, hoursBetween, pickDelegate, pickNextTier, planStepAction, type ApproverHolder } from "./escalation-rules";
import { buildApprovalEmail, subjectWordFor, type ApprovalEmailInput, type ApprovalEmailKind } from "./approval-emails";

/** Never read an unbounded queue in one tick; a backlog drains over several. */
export const SCAN_CAP = 500;

export interface ApprovalTickResult {
  assigned: number;
  reminded: number;
  delegated: number;
  escalated: number;
  decided: number;
  skipped: number;
  failed: number;
}

function scanPendingSteps() {
  return dbOperator.approvalStep.findMany({
    where: { status: "PENDING", request: { status: "PENDING" } },
    select: {
      id: true,
      organizationId: true,
      requestId: true,
      sequence: true,
      assigneeUserId: true,
      delegateUserId: true,
      dueAt: true,
      remindedAt: true,
      notifiedAt: true,
      createdAt: true,
      request: { select: { id: true, subjectType: true, subjectId: true, amountAed: true, amount: true, currency: true, requesterUserId: true, payload: true } },
    },
    orderBy: { createdAt: "asc" },
    take: SCAN_CAP,
  });
}

function scanDecided(windowStart: Date) {
  return dbOperator.approvalRequest.findMany({
    where: { status: { in: ["APPROVED", "REJECTED"] }, decisionNotifiedAt: null, decidedAt: { gte: windowStart } },
    select: {
      id: true,
      organizationId: true,
      status: true,
      subjectType: true,
      subjectId: true,
      amountAed: true,
      amount: true,
      currency: true,
      requesterUserId: true,
      payload: true,
      steps: { where: { status: { in: ["APPROVED", "REJECTED"] } }, select: { decidedByUserId: true, note: true }, orderBy: { sequence: "desc" }, take: 1 },
    },
    orderBy: { decidedAt: "asc" },
    take: SCAN_CAP,
  });
}

type PendingStepRow = Awaited<ReturnType<typeof scanPendingSteps>>[number];
type DecidedRow = Awaited<ReturnType<typeof scanDecided>>[number];
type SubjectRow = { subjectType: string; subjectId: string; amountAed: unknown; amount: unknown; currency: string | null; payload: unknown };

interface Person {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  deactivatedAt: Date | null;
}

export async function runApprovalNotificationsTick(now: Date = new Date()): Promise<ApprovalTickResult> {
  const result: ApprovalTickResult = { assigned: 0, reminded: 0, delegated: 0, escalated: 0, decided: 0, skipped: 0, failed: 0 };
  // Approvals have one consumer today, the Budget & Procurement module; with it
  // off on a deployment there is nothing to notify and nothing to scan.
  if (!isProcurementModuleEnabled()) {
    apiLogger.debug({ msg: "approvals-notify:module-off" });
    return result;
  }
  const windowStart = new Date(now.getTime() - NOTIFY_WINDOW_DAYS * 86_400_000);

  const [steps, decided] = await Promise.all([scanPendingSteps(), scanDecided(windowStart)]);
  if (steps.length === SCAN_CAP || decided.length === SCAN_CAP) {
    apiLogger.warn({ msg: "approvals-notify:scan-capped", pendingSteps: steps.length, decided: decided.length, cap: SCAN_CAP });
  }

  const orgIds = [...new Set([...steps.map((s) => s.organizationId), ...decided.map((r) => r.organizationId)])];
  for (const orgId of orgIds) {
    try {
      await runWithTenant(orgId, () =>
        processOrg(orgId, steps.filter((s) => s.organizationId === orgId), decided.filter((r) => r.organizationId === orgId), now, windowStart, result),
      );
    } catch (err) {
      result.failed++;
      apiLogger.error({ msg: "approvals-notify:org-failed", organizationId: orgId, err });
    }
  }

  const acted = result.assigned + result.reminded + result.delegated + result.escalated + result.decided;
  if (acted > 0 || result.failed > 0) apiLogger.info({ msg: "approvals-notify:tick", ...result });
  else apiLogger.debug({ msg: "approvals-notify:tick-idle", pendingSteps: steps.length });
  return result;
}

async function processOrg(orgId: string, steps: PendingStepRow[], decided: DecidedRow[], now: Date, windowStart: Date, result: ApprovalTickResult) {
  // Who can decide, from the grant columns (the truth), minus the settle grant,
  // which never decides whatever else a row holds.
  const holderRows = await db.user.findMany({
    where: {
      organizationId: orgId,
      deactivatedAt: null,
      procurementSettle: false,
      OR: [{ procurementApproveUnlimited: true }, { procurementApproveCeilingAed: { gt: 0 } }],
    },
    select: { id: true, procurementApproveCeilingAed: true, procurementApproveUnlimited: true, procurementDelegateUserId: true },
  });
  const holders: ApproverHolder[] = holderRows.map((h) => ({
    id: h.id,
    ceilingAed: approvalCeilingAed(procurementGrantsFromRow(h)) ?? 0,
    delegateUserId: h.procurementDelegateUserId,
  }));

  const personIds = new Set<string>();
  for (const s of steps) {
    personIds.add(s.assigneeUserId);
    personIds.add(s.request.requesterUserId);
    if (s.delegateUserId) personIds.add(s.delegateUserId);
  }
  for (const h of holders) personIds.add(h.id);
  for (const r of decided) {
    personIds.add(r.requesterUserId);
    if (r.steps[0]?.decidedByUserId) personIds.add(r.steps[0].decidedByUserId);
  }
  const people = new Map<string, Person>(
    (await db.user.findMany({ where: { organizationId: orgId, id: { in: [...personIds] } }, select: { id: true, firstName: true, lastName: true, email: true, deactivatedAt: true } })).map((p) => [p.id, p]),
  );
  const nameOf = (id: string | null | undefined) => {
    const p = id ? people.get(id) : undefined;
    return p ? `${p.firstName} ${p.lastName}`.trim() || p.email : null;
  };

  const labels = await subjectLabels(orgId, [...steps.map((s) => s.request), ...decided]);
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const approvalsLink = appUrl ? `${appUrl}/procurement/approvals` : null;

  const deliver = async (kind: ApprovalEmailKind, recipientId: string | null | undefined, build: Omit<ApprovalEmailInput, "kind" | "recipientFirstName">, ref: string) => {
    const recipient = recipientId ? people.get(recipientId) : undefined;
    if (!recipient || !recipient.email || recipient.deactivatedAt) {
      result.skipped++;
      apiLogger.warn({ msg: "approvals-notify:recipient-unreachable", kind, organizationId: orgId, ref, recipientUserId: recipientId ?? null, deactivated: !!recipient?.deactivatedAt });
      return;
    }
    const email = buildApprovalEmail({ kind, recipientFirstName: recipient.firstName, ...build });
    try {
      const sent = await sendEmail({
        to: [{ email: recipient.email, name: `${recipient.firstName} ${recipient.lastName}`.trim() || undefined }],
        subject: email.subject,
        htmlContent: email.html,
        textContent: email.text,
        logContext: { organizationId: orgId, entityType: "USER", entityId: recipient.id, templateSlug: `procurement-approval-${kind}` },
      });
      if (!sent.success) {
        result.failed++;
        apiLogger.error({ msg: "approvals-notify:send-failed", kind, organizationId: orgId, ref, recipientUserId: recipient.id, error: sent.error, code: sent.code });
      }
    } catch (err) {
      result.failed++;
      apiLogger.error({ msg: "approvals-notify:send-failed", kind, organizationId: orgId, ref, recipientUserId: recipient.id, err });
    }
  };

  const baseFor = (r: SubjectRow, requesterUserId: string, link: string | null) => ({
    subjectWord: subjectWordFor(r.subjectType, payloadKind(r.payload)),
    subjectLabel: labels.get(`${r.subjectType}:${r.subjectId}`) ?? (r.subjectType === "SPEND_REQUEST" ? "A spend request" : "A budget"),
    amountLine: amountLine(r),
    requesterName: nameOf(requesterUserId),
    exception: requiresFinalApprover(r.payload),
    link,
  });

  for (const step of steps) {
    const r = step.request;
    const ref = `step:${step.id}`;
    const base = baseFor(r, r.requesterUserId, approvalsLink);
    const waited = hoursBetween(step.createdAt, now);

    // 1. The assignment email, once. A step the worker only now sees past its
    // due time counts this email as its reminder too, so it is not followed
    // by a second one five minutes later.
    if (step.notifiedAt === null && step.createdAt >= windowStart) {
      const claim = await db.approvalStep.updateMany({
        where: { id: step.id, organizationId: orgId, status: "PENDING", notifiedAt: null },
        data: { notifiedAt: now, ...(now >= step.dueAt && step.remindedAt === null ? { remindedAt: now } : {}) },
      });
      if (claim.count === 0) {
        result.skipped++;
        continue;
      }
      result.assigned++;
      await deliver("assigned", step.assigneeUserId, base, ref);
      continue;
    }

    // 2. Everything else runs off the plan.
    const amountAed = Number(String(r.amountAed));
    const requireFinal = requiresFinalApprover(r.payload);
    const assignee = holders.find((h) => h.id === step.assigneeUserId);
    const assigneeCeiling = assignee?.ceilingAed ?? 0;
    const assigneeCanDecide =
      step.assigneeUserId !== r.requesterUserId && (requireFinal ? assigneeCeiling === Number.POSITIVE_INFINITY : Number.isFinite(amountAed) && amountAed <= assigneeCeiling);
    const nextTierUserId = pickNextTier({ holders, amountAed, requesterUserId: r.requesterUserId, currentUserId: step.assigneeUserId, currentCeilingAed: assigneeCeiling, requireFinal });
    const delegate = pickDelegate({ holders, assigneeUserId: step.assigneeUserId, amountAed, requesterUserId: r.requesterUserId, requireFinal });
    const action = planStepAction(step, { now, assigneeCanDecide, assigneeIsFinal: assigneeCeiling === Number.POSITIVE_INFINITY, nextTierUserId, delegate });

    switch (action.kind) {
      case "none":
        break;

      case "remind": {
        const claim = await db.approvalStep.updateMany({
          where: { id: step.id, organizationId: orgId, status: "PENDING", remindedAt: step.remindedAt },
          data: { remindedAt: now },
        });
        if (claim.count === 0) {
          result.skipped++;
          break;
        }
        result.reminded++;
        if (!assigneeCanDecide) {
          // Nobody above them either: the request cannot move until someone is
          // granted authority. Said once a day, with the reminder, not every tick.
          apiLogger.warn({ msg: "approvals-notify:no-one-can-decide", organizationId: orgId, requestId: r.id, assigneeUserId: step.assigneeUserId, amountAed });
        }
        const recipients = [...new Set([step.assigneeUserId, step.delegateUserId].filter((v): v is string => !!v))];
        for (const recipientId of recipients) await deliver("reminder", recipientId, { ...base, hoursWaiting: waited }, ref);
        break;
      }

      case "delegate": {
        const claim = await db.approvalStep.updateMany({
          where: { id: step.id, organizationId: orgId, status: "PENDING", delegateUserId: null },
          data: { delegateUserId: action.toUserId, ...(step.remindedAt === null ? { remindedAt: now } : {}) },
        });
        if (claim.count === 0) {
          result.skipped++;
          break;
        }
        result.delegated++;
        await audit(orgId, "APPROVAL_DELEGATED", r.id, {
          source: "worker",
          subjectType: r.subjectType,
          subjectId: r.subjectId,
          stepId: step.id,
          fromUserId: step.assigneeUserId,
          toUserId: action.toUserId,
          via: action.via,
          afterHours: Math.floor(waited),
        });
        await deliver("delegated", action.toUserId, { ...base, previousApproverName: nameOf(step.assigneeUserId), hoursWaiting: waited }, ref);
        break;
      }

      case "escalate": {
        const opened = await escalate(orgId, step, action.toUserId, now);
        if (!opened) {
          result.skipped++;
          break;
        }
        result.escalated++;
        await audit(orgId, "APPROVAL_ESCALATED", r.id, {
          source: "worker",
          subjectType: r.subjectType,
          subjectId: r.subjectId,
          fromStepId: step.id,
          toStepId: opened.id,
          fromUserId: step.assigneeUserId,
          toUserId: action.toUserId,
          reason: action.reason,
          afterHours: Math.floor(waited),
        });
        // An approver who lost their authority did not sit on it, so the new
        // assignee is told what it is, not that someone failed to act.
        await deliver(
          action.reason === "no-decision" ? "escalated" : "assigned",
          action.toUserId,
          { ...base, previousApproverName: nameOf(step.assigneeUserId), hoursWaiting: waited },
          `step:${opened.id}`,
        );
        break;
      }
    }
  }

  for (const r of decided) {
    const claim = await db.approvalRequest.updateMany({
      where: { id: r.id, organizationId: orgId, status: r.status, decisionNotifiedAt: null },
      data: { decisionNotifiedAt: now },
    });
    if (claim.count === 0) {
      result.skipped++;
      continue;
    }
    result.decided++;
    const decidingStep = r.steps[0];
    await deliver(
      "decided",
      r.requesterUserId,
      {
        ...baseFor(r, r.requesterUserId, appUrl ? `${appUrl}${subjectPath(r.subjectType, r.subjectId)}` : null),
        exception: false,
        decision: r.status === "APPROVED" ? "APPROVED" : "REJECTED",
        deciderName: nameOf(decidingStep?.decidedByUserId),
        note: decidingStep?.note ?? null,
      },
      `request:${r.id}`,
    );
  }
}

class EscalationAborted extends Error {}

/**
 * Closes the step as skipped and opens the next one for the next tier, in one
 * transaction. The claim on `escalatedAt` makes a second tick a no-op, and a
 * request decided or cancelled a moment earlier leaves nothing to escalate:
 * the decision claims the step first, a cancel skips it first.
 */
async function escalate(orgId: string, step: PendingStepRow, toUserId: string, now: Date): Promise<{ id: string } | null> {
  try {
    return await tenantTransaction(async (tx) => {
      const claim = await tx.approvalStep.updateMany({
        where: { id: step.id, organizationId: orgId, status: "PENDING", escalatedAt: null },
        data: { status: "SKIPPED", escalatedAt: now },
      });
      if (claim.count === 0) return null;
      const pending = await tx.approvalRequest.findFirst({ where: { id: step.requestId, organizationId: orgId, status: "PENDING" }, select: { id: true } });
      if (!pending) throw new EscalationAborted();
      return tx.approvalStep.create({
        data: {
          organizationId: orgId,
          requestId: step.requestId,
          sequence: step.sequence + 1,
          assigneeUserId: toUserId,
          dueAt: new Date(now.getTime() + DEFAULT_STEP_DUE_HOURS * 3_600_000),
          // The escalation email goes out from this tick, so the assignment
          // pass must not send a second one.
          notifiedAt: now,
        },
        select: { id: true },
      });
    });
  } catch (err) {
    if (err instanceof EscalationAborted) return null;
    throw err;
  }
}

async function audit(orgId: string, action: string, requestId: string, changes: Record<string, string | number | null>) {
  await db.auditLog
    .create({ data: { userId: null, organizationId: orgId, action, entityType: "ApprovalRequest", entityId: requestId, changes } })
    .catch((err) => apiLogger.error({ msg: "approvals-notify:audit-failed", action, organizationId: orgId, requestId, err }));
}

async function subjectLabels(orgId: string, subjects: { subjectType: string; subjectId: string }[]): Promise<Map<string, string>> {
  const budgetIds = [...new Set(subjects.filter((s) => s.subjectType !== "SPEND_REQUEST").map((s) => s.subjectId))];
  const requestIds = [...new Set(subjects.filter((s) => s.subjectType === "SPEND_REQUEST").map((s) => s.subjectId))];
  const [budgets, requests] = await Promise.all([
    budgetIds.length
      ? db.eventBudget.findMany({ where: { id: { in: budgetIds }, organizationId: orgId }, select: { id: true, eventCode: true, versionNo: true, event: { select: { name: true } } } })
      : [],
    requestIds.length ? db.spendRequest.findMany({ where: { id: { in: requestIds }, organizationId: orgId }, select: { id: true, requestNo: true, title: true } }) : [],
  ]);
  const out = new Map<string, string>();
  for (const b of budgets) {
    const label = `${b.eventCode} v${b.versionNo}${b.event?.name ? ` · ${b.event.name}` : ""}`;
    out.set(`BUDGET:${b.id}`, label);
    out.set(`BUDGET_REALLOCATION:${b.id}`, label);
  }
  for (const r of requests) out.set(`SPEND_REQUEST:${r.id}`, `${r.requestNo} · ${r.title}`);
  return out;
}

function payloadKind(payload: unknown): string | null {
  const k = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { kind?: unknown }).kind : null;
  return typeof k === "string" ? k : null;
}

function money(v: unknown): string {
  const n = Number(String(v));
  return Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00";
}

function amountLine(r: SubjectRow): string {
  const aed = `AED ${money(r.amountAed)}`;
  const cur = r.currency?.toUpperCase();
  if (cur && cur !== "AED" && r.amount !== null && r.amount !== undefined) return `${cur} ${money(r.amount)} (${aed})`;
  return aed;
}

export function subjectPath(subjectType: string, subjectId: string): string {
  return subjectType === "SPEND_REQUEST" ? `/procurement/requests/${subjectId}` : `/procurement/budgets/${subjectId}`;
}
