import { NextResponse } from "next/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { updateTask, completeTask, reopenTask, deleteTask } from "@/crm/services/task-service";

const updateTaskSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  remindAt: z.coerce.date().nullable().optional(),
  ownerId: z.string().min(1).nullable().optional(),
  /** Completion is a state transition, not a field write — it gets its own claim. */
  status: z.enum(["OPEN", "DONE"]).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const [{ error, ctx }, { taskId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = updateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/tasks/[taskId]:PATCH", organizationId: ctx.organizationId, taskId });
  }

  const { status, ...fields } = parsed.data;
  const common = {
    taskId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: (ctx.fromApiKey ? "api" : "rest") as "api" | "rest",
  };

  // Route the status transition through its own conditional-claim helper rather
  // than writing `status` as a plain field — a double-clicked "Done" would
  // otherwise re-stamp completedAt and corrupt "tasks completed this week".
  if (status === "DONE") {
    const result = await completeTask(common);
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({ task: result.task });
  }
  if (status === "OPEN") {
    const result = await reopenTask(common);
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({ task: result.task });
  }

  const result = await updateTask({ ...common, ...fields });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ task: result.task });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const [{ error, ctx }, { taskId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const result = await deleteTask({
    taskId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ success: true });
}
