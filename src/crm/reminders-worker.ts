/**
 * CRM task reminders.
 *
 * Emails a task's owner when it falls due. The deal-detail sheet promises "you'll
 * get an email when it's due" — this is the thing that has to make that true.
 *
 * IDEMPOTENCY IS THE WHOLE JOB.
 * `remindedAt` is the stamp, and it is written with a CONDITIONAL CLAIM
 * (`updateMany where { id, remindedAt: null }`) BEFORE the email is sent. Zero rows
 * = another tick (or another worker, mid-failover) already claimed it, so we skip.
 *
 * Claiming BEFORE sending means the worst case is a reminder that is claimed but
 * never delivered (we log it loudly). Claiming AFTER sending would make the worst
 * case a reminder emailed twice — or ten times, if the send is slow and the tick
 * overlaps. Given the choice, a missed reminder with an error line beats spamming
 * someone's inbox with the same nag.
 *
 * The predicate (`remindAt <= now AND remindedAt IS NULL AND status = OPEN`) is
 * served by the partial index added in the CRM migration. A COMPLETED task drops
 * out of the queue via status alone — which is exactly why completeTask() must not
 * clear `remindedAt`.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendEmail } from "@/lib/email";

/** Never fan out unboundedly on a single tick — a backlog drains over several. */
const BATCH = 50;

export interface CrmReminderTickResult {
  due: number;
  sent: number;
  skipped: number;
  failed: number;
}

export async function runTick(): Promise<CrmReminderTickResult> {
  const now = new Date();

  const due = await db.crmTask.findMany({
    where: {
      status: "OPEN",
      remindedAt: null,
      remindAt: { not: null, lte: now },
      // No owner, no one to remind. These are surfaced in the UI as "Unassigned"
      // rather than silently dropped.
      ownerId: { not: null },
    },
    select: {
      id: true,
      title: true,
      description: true,
      dueAt: true,
      organizationId: true,
      owner: { select: { id: true, email: true, firstName: true } },
      deal: { select: { id: true, name: true } },
      company: { select: { id: true, name: true } },
    },
    orderBy: { remindAt: "asc" },
    take: BATCH,
  });

  const result: CrmReminderTickResult = { due: due.length, sent: 0, skipped: 0, failed: 0 };
  if (due.length === 0) return result;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

  for (const task of due) {
    // CLAIM FIRST. If another tick beat us to this row, count===0 and we skip —
    // no email, no double-nag.
    const claim = await db.crmTask.updateMany({
      where: { id: task.id, remindedAt: null, status: "OPEN" },
      data: { remindedAt: new Date() },
    });

    if (claim.count === 0) {
      result.skipped++;
      apiLogger.debug({ msg: "crm-reminder:already-claimed", taskId: task.id });
      continue;
    }

    if (!task.owner?.email) {
      // Claimed but undeliverable. Do not un-claim: an owner-less task would then
      // be re-picked on every single tick, forever.
      result.skipped++;
      apiLogger.warn({ msg: "crm-reminder:owner-has-no-email", taskId: task.id });
      continue;
    }

    const context = task.deal?.name ?? task.company?.name ?? null;
    const dueLine = task.dueAt
      ? `Due ${task.dueAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`
      : "Due now";

    try {
      await sendEmail({
        to: [{ email: task.owner.email, name: task.owner.firstName ?? undefined }],
        subject: `Follow-up due: ${task.title}`,
        htmlContent: `
          <p>Hi ${escapeHtml(task.owner.firstName ?? "there")},</p>
          <p>This follow-up is due:</p>
          <p style="padding:12px 16px;border-left:3px solid #00aade;background:#f6fbfd;">
            <strong>${escapeHtml(task.title)}</strong><br/>
            ${escapeHtml(dueLine)}
            ${context ? `<br/><span style="color:#666;">${escapeHtml(context)}</span>` : ""}
          </p>
          ${task.description ? `<p>${escapeHtml(task.description)}</p>` : ""}
          ${appUrl ? `<p><a href="${appUrl}/crm/tasks">Open your tasks</a></p>` : ""}
        `,
        textContent: [
          `Follow-up due: ${task.title}`,
          dueLine,
          context ? `Related to: ${context}` : "",
          task.description ?? "",
          appUrl ? `${appUrl}/crm/tasks` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        logContext: {
          entityType: "USER",
          entityId: task.owner.id,
          organizationId: task.organizationId,
          templateSlug: "crm-task-reminder",
        },
      });

      result.sent++;
      apiLogger.info({ msg: "crm-reminder:sent", taskId: task.id, ownerId: task.owner.id });
    } catch (err) {
      // The row stays CLAIMED. That is deliberate: retrying a send by un-claiming
      // risks a double-send on a transient failure that actually delivered. A
      // missed reminder is recoverable by a human looking at an OPEN overdue task;
      // an inbox full of duplicate nags is not.
      result.failed++;
      apiLogger.error({
        msg: "crm-reminder:send-failed",
        taskId: task.id,
        ownerId: task.owner.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  apiLogger.info({ msg: "crm-reminder:tick", ...result });
  return result;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
