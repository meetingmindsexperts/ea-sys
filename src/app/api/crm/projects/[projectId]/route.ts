import { NextResponse } from "next/server";
import { z } from "zod";
import { runWithTenant } from "@/lib/tenant-context";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, requireCrmDelete, denyCrmDelete, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { archiveAlone } from "@/crm/lib/crm-archive-patch";
import { PROJECT_SELECT, parseDay, projectRow } from "@/crm/lib/project-rows";
import { setProjectArchived, updateProject } from "@/crm/services/project-service";

/** A calendar day as YYYY-MM-DD; null clears it. */
const day = z
  .string()
  .max(10)
  .nullable()
  .optional()
  .refine((v) => !v || parseDay(v) !== null, { message: "Use a real date, as YYYY-MM-DD" });

const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    companyId: z.string().min(1).max(64).nullable().optional(),
    startDate: day,
    endDate: day,
    location: z.string().max(255).nullable().optional(),
    ownerId: z.string().min(1).max(64).nullable().optional(),
    // The event this project duplicates; null clears the link (deal-attribution.ts).
    eventId: z.string().min(1).max(64).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .superRefine(archiveAlone);

/** undefined stays "not sent"; "" and null both clear the day. */
function dayInput(v: string | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  return v ? parseDay(v) : null;
}

/**
 * GET /api/crm/projects/[projectId]: one corporate project with its totals and
 * its deals (newest first, archived ones left out).
 */
export async function GET(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const [{ error, ctx }, { projectId }] = await Promise.all([requireCrmRead(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    try {
      const [project, deals] = await Promise.all([
        db.crmProject.findFirst({ where: { id: projectId, organizationId: ctx.organizationId }, select: PROJECT_SELECT }),
        db.crmDeal.findMany({
          where: { projectId, organizationId: ctx.organizationId, archivedAt: null },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 500,
          select: {
            id: true,
            name: true,
            status: true,
            dealValue: true,
            currency: true,
            expectedClose: true,
            stage: { select: { id: true, name: true } },
            company: { select: { id: true, name: true } },
            owner: { select: { id: true, firstName: true, lastName: true } },
          },
        }),
      ]);
      if (!project) {
        apiLogger.warn({ msg: "crm/projects:not-found", projectId, organizationId: ctx.organizationId });
        return NextResponse.json({ error: "Corporate project not found", code: "PROJECT_NOT_FOUND" }, { status: 404 });
      }
      return NextResponse.json({ project: redactForCaller({ ...projectRow(project), deals }, ctx) });
    } catch (err) {
      apiLogger.error({ msg: "crm/projects:detail-failed", projectId, err: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: "Could not load the project" }, { status: 500 });
    }
  });
}

/**
 * PATCH /api/crm/projects/[projectId]: edit a project, link it to the event it
 * duplicates (or clear that link), or archive / restore it on its own.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const [{ error, ctx }, { projectId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const parsed = updateProjectSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route: "crm/projects/[projectId]:PATCH", organizationId: ctx.organizationId, projectId });
    }
    const { archived, startDate, endDate, ...fields } = parsed.data;
    const caller = { projectId, organizationId: ctx.organizationId, userId: ctx.userId, source: ctx.fromApiKey ? ("api" as const) : ("rest" as const) };

    if (archived !== undefined) {
      const denied = denyCrmDelete(ctx);
      if (denied) return denied;
      const result = await setProjectArchived({ ...caller, archived });
      if (!result.ok) return crmErrorResponse(result);
      return NextResponse.json({ project: { id: result.project.id, archivedAt: result.project.archivedAt } });
    }

    const result = await updateProject({ ...fields, startDate: dayInput(startDate), endDate: dayInput(endDate), ...caller });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({ project: { id: result.project.id, name: result.project.name, eventId: result.project.eventId } });
  });
}

/** DELETE /api/crm/projects/[projectId]: archive (soft delete). Its deals are untouched. */
export async function DELETE(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const [{ error, ctx }, { projectId }] = await Promise.all([requireCrmDelete(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const result = await setProjectArchived({
      projectId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      source: ctx.fromApiKey ? "api" : "rest",
      archived: true,
    });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({ project: { id: result.project.id, archivedAt: result.project.archivedAt }, archived: true });
  });
}
