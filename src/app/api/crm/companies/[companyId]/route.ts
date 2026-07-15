import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, requireCrmDelete, denyCrmDelete, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { updateCompany, setCompanyArchived } from "@/crm/services/company-service";

const updateCompanySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  industry: z.string().max(100).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  /** Cleared once a human confirms a fuzzy-flagged company is genuinely distinct. */
  needsReview: z.boolean().optional(),
  /** Restore a soft-deleted account. Delete-gated separately below. */
  archived: z.boolean().optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const [{ error, ctx }, { companyId }] = await Promise.all([requireCrmRead(req), params]);
  if (error) return error;

  try {
    const company = await db.crmCompany.findFirst({
      where: { id: companyId, organizationId: ctx.organizationId },
      include: {
        contacts: {
          where: { archivedAt: null },
          select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true, lifecycleStage: true },
          orderBy: { lastName: "asc" },
          take: 200,
        },
        deals: {
          where: { archivedAt: null },
          select: {
            id: true, name: true, dealValue: true, currency: true, status: true, stageId: true,
            event: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        },
      },
    });

    if (!company) {
      apiLogger.warn({ msg: "crm/companies:detail-not-found", companyId, organizationId: ctx.organizationId });
      return NextResponse.json({ error: "Company not found" }, { status: 404 });
    }

    return NextResponse.json({ company: redactForCaller(company, ctx) });
  } catch (err) {
    apiLogger.error({
      msg: "crm/companies:detail-failed",
      companyId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load the company" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const [{ error, ctx }, { companyId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = updateCompanySchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/companies/[companyId]:PATCH", organizationId: ctx.organizationId, companyId });
  }

  const { archived, ...fields } = parsed.data;

  if (archived !== undefined) {
    const denied = denyCrmDelete(ctx);
    if (denied) return denied;
    const result = await setCompanyArchived({
      companyId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      source: ctx.fromApiKey ? "api" : "rest",
      archived,
    });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({ company: redactForCaller(result.company, ctx) });
  }

  const result = await updateCompany({
    ...fields,
    companyId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
    requestIp: getClientIp(req) ?? undefined,
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ company: redactForCaller(result.company, ctx) });
}

/** DELETE /api/crm/companies/[companyId] — archive (soft delete). Admin + CRM_USER only. */
export async function DELETE(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const [{ error, ctx }, { companyId }] = await Promise.all([requireCrmDelete(req), params]);
  if (error) return error;

  const result = await setCompanyArchived({
    companyId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
    archived: true,
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ company: redactForCaller(result.company, ctx), archived: true });
}
