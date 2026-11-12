import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { runWithTenant } from "@/lib/tenant-context";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { CRM_PROJECTS_LIST_CAP, listMeta } from "@/crm/lib/list-caps";
import { isArchivedView } from "@/crm/lib/deal-filters";
import { PROJECT_SELECT, parseDay, projectRow } from "@/crm/lib/project-rows";
import { createProject } from "@/crm/services/project-service";

/** A calendar day as YYYY-MM-DD; "" and null both mean "not set". */
const day = z
  .string()
  .max(10)
  .nullable()
  .optional()
  .refine((v) => !v || parseDay(v) !== null, { message: "Use a real date, as YYYY-MM-DD" });

const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  companyId: z.string().min(1).max(64).nullable().optional(),
  startDate: day,
  endDate: day,
  location: z.string().max(255).nullable().optional(),
  ownerId: z.string().min(1).max(64).nullable().optional(),
  eventId: z.string().min(1).max(64).nullable().optional(),
});

/**
 * GET /api/crm/projects: the organisation's corporate projects, each with its
 * deal counts and per-currency totals (Nov 12, 2026). The deal form's picker
 * and the Projects page both read it. ?q= (name), ?companyId=, ?ownerId=,
 * ?archived=1 for the archived view.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    try {
      const { searchParams } = new URL(req.url);
      const q = searchParams.get("q")?.trim();
      const companyId = searchParams.get("companyId")?.trim();
      const ownerId = searchParams.get("ownerId")?.trim();
      const where: Prisma.CrmProjectWhereInput = {
        organizationId: ctx.organizationId,
        archivedAt: isArchivedView(searchParams.get("archived")) ? { not: null } : null,
        ...(companyId ? { companyId } : {}),
        ...(ownerId ? { ownerId } : {}),
        ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
      };
      const [rows, total] = await Promise.all([
        db.crmProject.findMany({
          where,
          select: PROJECT_SELECT,
          // Newest first: the project a rep just made is the one they pick next.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: CRM_PROJECTS_LIST_CAP,
        }),
        db.crmProject.count({ where }),
      ]);
      const projects = rows.map(projectRow);
      return NextResponse.json({ projects: redactForCaller(projects, ctx), ...listMeta(total, projects.length) });
    } catch (err) {
      apiLogger.error({ msg: "crm/projects:list-failed", organizationId: ctx.organizationId, err: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: "Could not load the projects" }, { status: 500 });
    }
  });
}

/** POST /api/crm/projects: create a corporate project. Anyone who may create deals may (owner). */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const parsed = createProjectSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route: "crm/projects:POST", organizationId: ctx.organizationId });
    }
    const { startDate, endDate, ...fields } = parsed.data;
    const result = await createProject({
      ...fields,
      startDate: startDate ? parseDay(startDate) : null,
      endDate: endDate ? parseDay(endDate) : null,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      source: ctx.fromApiKey ? "api" : "rest",
    });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({ project: { id: result.project.id, name: result.project.name } }, { status: 201 });
  });
}
