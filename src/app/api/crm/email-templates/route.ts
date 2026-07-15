/**
 * /api/crm/email-templates — the org's reusable CRM email templates.
 *
 * GET (read): lists templates, seeding the built-in three on first use. POST
 * (write): create a template. Managed from the CRM "Templates" tab; consumed by the
 * compose dialog's "Start from a template" picker.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import {
  ensureCrmEmailTemplates,
  listCrmEmailTemplates,
  createCrmEmailTemplate,
} from "@/crm/services/crm-email-template-service";

export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;

  try {
    await ensureCrmEmailTemplates(ctx.organizationId);
    const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
    const templates = await listCrmEmailTemplates(ctx.organizationId, { includeArchived });
    return NextResponse.json({ templates });
  } catch (err) {
    apiLogger.error({
      msg: "crm/email-templates:list-failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load templates" }, { status: 500 });
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(50_000),
});

export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/email-templates:POST", organizationId: ctx.organizationId });
  }

  const result = await createCrmEmailTemplate({
    ...parsed.data,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
  });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ template: result.template }, { status: 201 });
}
