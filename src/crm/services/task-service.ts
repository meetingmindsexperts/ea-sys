/**
 * CRM task service — follow-ups and reminders.
 *
 * A task is the "chase Abbott about the Gold package before Friday" record. It
 * hangs off a deal, a company, or a contact (or nothing).
 *
 * The subtle part is `completeTask()` and the reminder stamp. `remindedAt` is the
 * idempotency key the worker writes; completing a task must NOT clear it, because
 * a cleared stamp on a still-due task would make the worker re-send the reminder
 * email. Completion sets status=DONE, and the worker's predicate requires
 * status=OPEN — so a completed task drops out of the reminder queue without any
 * stamp fiddling. Keep it that way.
 */
import { Prisma, type CrmTask } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordCrmActivity, diffFields } from "@/crm/lib/crm-activity";
import { notifyCrmUser } from "@/crm/lib/crm-notifications";

/** Fields worth showing in the change log when a task is edited. */
const TASK_DIFF_KEYS = ["title", "description", "dueAt", "remindAt", "ownerId"] as const;

export interface CreateTaskInput {
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
  requestIp?: string;

  title: string;
  description?: string | null;
  dueAt?: Date | null;
  remindAt?: Date | null;
  ownerId?: string | null;
  crmContactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
}

export interface UpdateTaskInput {
  taskId: string;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";

  title?: string;
  description?: string | null;
  dueAt?: Date | null;
  remindAt?: Date | null;
  ownerId?: string | null;
}

export type TaskErrorCode =
  | "TITLE_REQUIRED"
  | "TASK_NOT_FOUND"
  | "TASK_ARCHIVED"
  | "OWNER_NOT_FOUND"
  | "DEAL_NOT_FOUND"
  | "COMPANY_NOT_FOUND"
  | "CONTACT_NOT_FOUND"
  | "ALREADY_DONE"
  | "NO_FIELDS"
  | "UNKNOWN";

type Fail = { ok: false; code: TaskErrorCode; message: string; meta?: Record<string, unknown> };
export type TaskResult = { ok: true; task: CrmTask } | Fail;

/** Every attachable id is bound to the caller's org before it is written. */
async function validateRelations(
  organizationId: string,
  rel: { ownerId?: string | null; crmContactId?: string | null; companyId?: string | null; dealId?: string | null },
): Promise<Fail | null> {
  const checks: Array<Promise<Fail | null>> = [];

  if (rel.ownerId) {
    checks.push(
      db.user
        .findFirst({ where: { id: rel.ownerId, organizationId }, select: { id: true } })
        .then((r) => (r ? null : ({ ok: false, code: "OWNER_NOT_FOUND", message: "Owner not found in this organization" } as Fail))),
    );
  }
  if (rel.dealId) {
    checks.push(
      db.crmDeal
        .findFirst({ where: { id: rel.dealId, organizationId }, select: { id: true } })
        .then((r) => (r ? null : ({ ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" } as Fail))),
    );
  }
  if (rel.companyId) {
    checks.push(
      db.crmCompany
        .findFirst({ where: { id: rel.companyId, organizationId }, select: { id: true } })
        .then((r) => (r ? null : ({ ok: false, code: "COMPANY_NOT_FOUND", message: "Company not found" } as Fail))),
    );
  }
  if (rel.crmContactId) {
    checks.push(
      db.crmContact
        .findFirst({ where: { id: rel.crmContactId, organizationId }, select: { id: true } })
        .then((r) => (r ? null : ({ ok: false, code: "CONTACT_NOT_FOUND", message: "Contact not found" } as Fail))),
    );
  }

  const results = await Promise.all(checks);
  return results.find((r) => r !== null) ?? null;
}

export async function createTask(input: CreateTaskInput): Promise<TaskResult> {
  const title = input.title?.trim() ?? "";
  if (!title) return { ok: false, code: "TITLE_REQUIRED", message: "Task title is required" };

  const relFail = await validateRelations(input.organizationId, input);
  if (relFail) {
    apiLogger.warn({ msg: "crm-task:create-bad-relation", code: relFail.code, organizationId: input.organizationId });
    return relFail;
  }

  try {
    const task = await db.crmTask.create({
      data: {
        organizationId: input.organizationId,
        title,
        description: input.description?.trim() || null,
        dueAt: input.dueAt ?? null,
        remindAt: input.remindAt ?? null,
        ownerId: input.ownerId ?? null,
        crmContactId: input.crmContactId ?? null,
        companyId: input.companyId ?? null,
        dealId: input.dealId ?? null,
        createdById: input.userId,
      },
    });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "TASK",
      entityId: task.id,
      action: "CREATE",
      actorId: input.userId,
      changes: { source: input.source, title, dealId: task.dealId, ownerId: task.ownerId },
    });

    // Assigning a task to someone else tells them. The route defaults ownerId to
    // the creator, and the writer skips that self-assign case — so only genuine
    // "do this, please" assignments notify.
    void notifyCrmUser({
      organizationId: input.organizationId,
      recipientId: task.ownerId,
      actorId: input.userId,
      type: "TASK_ASSIGNED",
      title: "Task assigned to you",
      message: `You've been assigned "${task.title}"`,
      link: "/crm/tasks",
    });

    apiLogger.info({ msg: "crm-task:created", taskId: task.id, organizationId: input.organizationId, source: input.source });
    return { ok: true, task };
  } catch (err) {
    apiLogger.error({
      msg: "crm-task:create-failed",
      organizationId: input.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not create the task" };
  }
}

export async function updateTask(input: UpdateTaskInput): Promise<TaskResult> {
  const data: Prisma.CrmTaskUpdateManyMutationInput & { ownerId?: string | null } = {};

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) return { ok: false, code: "TITLE_REQUIRED", message: "Task title cannot be empty" };
    data.title = title;
  }
  if (input.description !== undefined) data.description = input.description?.trim() || null;
  if (input.dueAt !== undefined) data.dueAt = input.dueAt;
  if (input.ownerId !== undefined) data.ownerId = input.ownerId;

  if (input.remindAt !== undefined) {
    data.remindAt = input.remindAt;
    // Re-arming the reminder clears the sent-stamp — otherwise moving a reminder
    // to a NEW time would never fire, because the worker skips any row whose
    // remindedAt is already set. Changing WHEN you want to be reminded must
    // actually change when you are reminded.
    data.remindedAt = null;
  }

  if (Object.keys(data).length === 0) {
    return { ok: false, code: "NO_FIELDS", message: "No fields to update" };
  }

  const relFail = await validateRelations(input.organizationId, { ownerId: input.ownerId });
  if (relFail) return relFail;

  try {
    const before = await db.crmTask.findFirst({
      where: { id: input.taskId, organizationId: input.organizationId },
      select: { title: true, description: true, dueAt: true, remindAt: true, ownerId: true },
    });
    if (!before) {
      apiLogger.warn({ msg: "crm-task:update-not-found", taskId: input.taskId, organizationId: input.organizationId });
      return { ok: false, code: "TASK_NOT_FOUND", message: "Task not found" };
    }

    // Moving the DUE date moves the reminder with it (CRM review M12) — when the
    // reminder was armed AT the old due date (the only create surface sets
    // remindAt = dueAt) and the caller didn't set remindAt explicitly. Otherwise
    // the promise "you'll get an email when it's due" silently breaks: the old
    // reminder either already fired (none comes at the new date) or fires early.
    if (
      input.dueAt !== undefined &&
      input.remindAt === undefined &&
      before.dueAt &&
      before.remindAt &&
      before.remindAt.getTime() === before.dueAt.getTime()
    ) {
      data.remindAt = input.dueAt;
      data.remindedAt = null; // re-arm — the worker skips rows already stamped
    }

    await db.crmTask.updateMany({
      where: { id: input.taskId, organizationId: input.organizationId },
      data,
    });

    const task = await db.crmTask.findUniqueOrThrow({ where: { id: input.taskId } });

    // Diff BEFORE + the submitted patch — NOT the post-write re-read (CRM review
    // M4): a concurrent writer landing between our write and a re-read would have
    // ITS change recorded under THIS actor's name in the History log. The patch
    // is what this actor actually did; diff exactly that.
    const fieldChanges = diffFields(before, { ...before, ...data } as typeof before, TASK_DIFF_KEYS);
    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "TASK",
      entityId: task.id,
      action: "UPDATE",
      actorId: input.userId,
      changes: { source: input.source, ...(fieldChanges ? { changes: fieldChanges } : {}) },
    });

    // Re-assignment notifies the NEW owner only (the writer skips self-assign);
    // compared against the pre-write snapshot so re-sending an unchanged ownerId
    // doesn't re-nag.
    if (input.ownerId !== undefined && input.ownerId !== null && input.ownerId !== before.ownerId) {
      void notifyCrmUser({
        organizationId: input.organizationId,
        recipientId: input.ownerId,
        actorId: input.userId,
        type: "TASK_ASSIGNED",
        title: "Task assigned to you",
        message: `You've been assigned "${task.title}"`,
        link: "/crm/tasks",
      });
    }

    apiLogger.info({ msg: "crm-task:updated", taskId: task.id, source: input.source });
    return { ok: true, task };
  } catch (err) {
    apiLogger.error({
      msg: "crm-task:update-failed",
      taskId: input.taskId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not update the task" };
  }
}

/**
 * Complete a task. Conditional claim on status=OPEN so a double-click can't
 * re-stamp `completedAt` (which would corrupt "tasks completed this week").
 *
 * Deliberately does NOT touch `remindedAt` — see the file header.
 */
export async function completeTask(input: {
  taskId: string;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
}): Promise<TaskResult> {
  try {
    const claim = await db.crmTask.updateMany({
      // archivedAt: null — an archived task is frozen (CRM review M1): completing
      // it from a stale list would stamp completedAt on a record nobody can see.
      where: { id: input.taskId, organizationId: input.organizationId, status: "OPEN", archivedAt: null },
      data: { status: "DONE", completedAt: new Date() },
    });

    if (claim.count === 0) {
      const current = await db.crmTask.findFirst({
        where: { id: input.taskId, organizationId: input.organizationId },
        select: { id: true, status: true, archivedAt: true },
      });
      if (!current) {
        apiLogger.warn({ msg: "crm-task:complete-not-found", taskId: input.taskId });
        return { ok: false, code: "TASK_NOT_FOUND", message: "Task not found" };
      }
      if (current.archivedAt) {
        apiLogger.warn({ msg: "crm-task:complete-archived", taskId: input.taskId });
        return { ok: false, code: "TASK_ARCHIVED", message: "This task was archived — restore it first" };
      }
      // Idempotent from the user's point of view — it IS done — but we report it
      // rather than pretend we just did it.
      apiLogger.warn({ msg: "crm-task:already-done", taskId: input.taskId });
      return { ok: false, code: "ALREADY_DONE", message: "This task is already complete" };
    }

    const task = await db.crmTask.findUniqueOrThrow({ where: { id: input.taskId } });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "TASK",
      entityId: task.id,
      action: "COMPLETE",
      actorId: input.userId,
      changes: { source: input.source, title: task.title, dealId: task.dealId },
    });

    apiLogger.info({ msg: "crm-task:completed", taskId: task.id, source: input.source });
    return { ok: true, task };
  } catch (err) {
    apiLogger.error({
      msg: "crm-task:complete-failed",
      taskId: input.taskId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not complete the task" };
  }
}

/** Reopen a completed task (undo). Clears completedAt; leaves remindedAt alone. */
export async function reopenTask(input: {
  taskId: string;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
}): Promise<TaskResult> {
  try {
    const claim = await db.crmTask.updateMany({
      where: { id: input.taskId, organizationId: input.organizationId, status: "DONE", archivedAt: null },
      data: { status: "OPEN", completedAt: null },
    });
    if (claim.count === 0) {
      apiLogger.warn({ msg: "crm-task:reopen-not-applicable", taskId: input.taskId });
      return { ok: false, code: "TASK_NOT_FOUND", message: "Task not found, or it is not complete" };
    }
    const task = await db.crmTask.findUniqueOrThrow({ where: { id: input.taskId } });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "TASK",
      entityId: task.id,
      action: "REOPEN",
      actorId: input.userId,
      changes: { source: input.source, title: task.title, dealId: task.dealId },
    });

    apiLogger.info({ msg: "crm-task:reopened", taskId: task.id, source: input.source });
    return { ok: true, task };
  } catch (err) {
    apiLogger.error({
      msg: "crm-task:reopen-failed",
      taskId: input.taskId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not reopen the task" };
  }
}

/**
 * Archive or restore a task (soft delete). Replaces the old hard `deleteTask` —
 * the whole CRM now soft-deletes so the change log survives. Idempotent; RBAC at
 * the route boundary.
 *
 * An archived task also drops out of the reminder worker's queue (the list + worker
 * predicates exclude `archivedAt != null`), so archiving a follow-up is a valid way
 * to cancel its reminder.
 */
export async function setTaskArchived(input: {
  taskId: string;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
  archived: boolean;
}): Promise<TaskResult> {
  try {
    const current = await db.crmTask.findFirst({
      where: { id: input.taskId, organizationId: input.organizationId },
    });
    if (!current) {
      apiLogger.warn({ msg: "crm-task:archive-not-found", taskId: input.taskId, organizationId: input.organizationId });
      return { ok: false, code: "TASK_NOT_FOUND", message: "Task not found" };
    }

    const alreadyInState = input.archived ? current.archivedAt !== null : current.archivedAt === null;
    if (alreadyInState) return { ok: true, task: current };

    const task = await db.crmTask.update({
      where: { id: current.id },
      data: { archivedAt: input.archived ? new Date() : null },
    });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "TASK",
      entityId: task.id,
      action: input.archived ? "ARCHIVE" : "RESTORE",
      actorId: input.userId,
      changes: { source: input.source, title: task.title },
    });

    apiLogger.info({
      msg: input.archived ? "crm-task:archived" : "crm-task:restored",
      taskId: task.id,
      source: input.source,
    });
    return { ok: true, task };
  } catch (err) {
    apiLogger.error({
      msg: "crm-task:archive-failed",
      taskId: input.taskId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not archive the task" };
  }
}
