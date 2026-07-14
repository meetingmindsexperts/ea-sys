import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { createTask } from "@/crm/services/task-service";

const createTaskSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(5000).optional().nullable(),
  dueAt: z.coerce.date().optional().nullable(),
  remindAt: z.coerce.date().optional().nullable(),
  ownerId: z.string().min(1).optional().nullable(),
  contactId: z.string().min(1).optional().nullable(),
  companyId: z.string().min(1).optional().nullable(),
  dealId: z.string().min(1).optional().nullable(),
});

/** GET /api/crm/tasks — "My Tasks" (default) or the whole org's, due-date first. */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;

  try {
    const { searchParams } = new URL(req.url);
    const scope = searchParams.get("scope"); // "mine" (default) | "all"
    const status = searchParams.get("status"); // "OPEN" (default) | "DONE" | "all"

    const tasks = await db.crmTask.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(scope === "all" ? {} : ctx.userId ? { ownerId: ctx.userId } : {}),
        ...(status === "all" ? {} : { status: status === "DONE" ? "DONE" : "OPEN" }),
      },
      select: {
        id: true,
        title: true,
        description: true,
        dueAt: true,
        remindAt: true,
        status: true,
        completedAt: true,
        owner: { select: { id: true, firstName: true, lastName: true } },
        deal: { select: { id: true, name: true } },
        company: { select: { id: true, name: true } },
        contact: { select: { id: true, firstName: true, lastName: true } },
      },
      // Nulls last so undated tasks don't crowd out the ones that are actually due.
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: 500,
    });

    return NextResponse.json({ tasks: redactForCaller(tasks, ctx) });
  } catch (err) {
    apiLogger.error({
      msg: "crm/tasks:list-failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load tasks" }, { status: 500 });
  }
}

/** POST /api/crm/tasks */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = createTaskSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/tasks:POST", organizationId: ctx.organizationId });
  }

  const result = await createTask({
    ...parsed.data,
    // A task nobody owns is a task nobody does — default it to the creator.
    ownerId: parsed.data.ownerId ?? ctx.userId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
    requestIp: getClientIp(req) ?? undefined,
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ task: result.task }, { status: 201 });
}
