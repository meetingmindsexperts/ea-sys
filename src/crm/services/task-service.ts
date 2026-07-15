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

    void writeAudit({
      userId: input.userId,
      action: "CREATE",
      entityId: task.id,
      ipAddress: input.requestIp,
      changes: { source: input.source, title, dealId: task.dealId, ownerId: task.ownerId },
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
    const res = await db.crmTask.updateMany({
      where: { id: input.taskId, organizationId: input.organizationId },
      data,
    });
    if (res.count === 0) {
      apiLogger.warn({ msg: "crm-task:update-not-found", taskId: input.taskId, organizationId: input.organizationId });
      return { ok: false, code: "TASK_NOT_FOUND", message: "Task not found" };
    }

    const task = await db.crmTask.findUniqueOrThrow({ where: { id: input.taskId } });

    void writeAudit({
      userId: input.userId,
      action: "UPDATE",
      entityId: task.id,
      changes: { source: input.source, fields: Object.keys(data) },
    });

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
      where: { id: input.taskId, organizationId: input.organizationId, status: "OPEN" },
      data: { status: "DONE", completedAt: new Date() },
    });

    if (claim.count === 0) {
      const current = await db.crmTask.findFirst({
        where: { id: input.taskId, organizationId: input.organizationId },
        select: { id: true, status: true },
      });
      if (!current) {
        apiLogger.warn({ msg: "crm-task:complete-not-found", taskId: input.taskId });
        return { ok: false, code: "TASK_NOT_FOUND", message: "Task not found" };
      }
      // Idempotent from the user's point of view — it IS done — but we report it
      // rather than pretend we just did it.
      apiLogger.warn({ msg: "crm-task:already-done", taskId: input.taskId });
      return { ok: false, code: "ALREADY_DONE", message: "This task is already complete" };
    }

    const task = await db.crmTask.findUniqueOrThrow({ where: { id: input.taskId } });

    void writeAudit({
      userId: input.userId,
      action: "TASK_COMPLETED",
      entityId: task.id,
      changes: { source: input.source, dealId: task.dealId },
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
      where: { id: input.taskId, organizationId: input.organizationId, status: "DONE" },
      data: { status: "OPEN", completedAt: null },
    });
    if (claim.count === 0) {
      apiLogger.warn({ msg: "crm-task:reopen-not-applicable", taskId: input.taskId });
      return { ok: false, code: "TASK_NOT_FOUND", message: "Task not found, or it is not complete" };
    }
    const task = await db.crmTask.findUniqueOrThrow({ where: { id: input.taskId } });

    void writeAudit({
      userId: input.userId,
      action: "TASK_REOPENED",
      entityId: task.id,
      changes: { source: input.source, dealId: task.dealId },
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

export async function deleteTask(input: {
  taskId: string;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
}): Promise<{ ok: true } | Fail> {
  try {
    const res = await db.crmTask.deleteMany({
      where: { id: input.taskId, organizationId: input.organizationId },
    });
    if (res.count === 0) {
      apiLogger.warn({ msg: "crm-task:delete-not-found", taskId: input.taskId, organizationId: input.organizationId });
      return { ok: false, code: "TASK_NOT_FOUND", message: "Task not found" };
    }

    void writeAudit({
      userId: input.userId,
      action: "DELETE",
      entityId: input.taskId,
      changes: { source: input.source },
    });

    apiLogger.info({ msg: "crm-task:deleted", taskId: input.taskId, source: input.source });
    return { ok: true };
  } catch (err) {
    apiLogger.error({
      msg: "crm-task:delete-failed",
      taskId: input.taskId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not delete the task" };
  }
}

function writeAudit(entry: {
  userId: string | null;
  action: string;
  entityId: string;
  ipAddress?: string;
  changes: Record<string, unknown>;
}) {
  return db.auditLog
    .create({
      data: {
        userId: entry.userId,
        action: entry.action,
        entityType: "CrmTask",
        entityId: entry.entityId,
        ipAddress: entry.ipAddress ?? null,
        changes: entry.changes as Prisma.InputJsonValue,
      },
    })
    .catch((err: unknown) => {
      apiLogger.error({
        msg: "crm-task:audit-failed",
        entityId: entry.entityId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
}
