/**
 * /api/crm/email-templates/[templateId] — edit / archive / restore one template.
 *
 * PATCH edits fields (write-gated) OR restores (`archived: false`, delete-gated).
 * DELETE archives (soft delete, delete-gated: admin + CRM_USER only — an ORGANIZER
 * may edit but not archive, same as every other CRM record).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, requireCrmDelete, denyCrmDelete, crmErrorResponse } from "@/crm/lib/crm-route";
import { updateCrmEmailTemplate, setCrmEmailTemplateArchived } from "@/crm/services/crm-email-template-service";

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  subject: z.string().min(1).max(300).optional(),
  body: z.string().min(1).max(50_000).optional(),
  /** Restore a soft-deleted template (archive → active). Delete-gated below. */
  archived: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ templateId: string }> }) {
  const [{ error, ctx }, { templateId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/email-templates/[templateId]:PATCH", organizationId: ctx.organizationId });
  }

  const { archived, ...fields } = parsed.data;

  if (archived !== undefined) {
    // Archive/restore is more privileged than a field edit (ORGANIZER may edit, not archive).
    const denied = denyCrmDelete(ctx);
    if (denied) return denied;
    const result = await setCrmEmailTemplateArchived({ templateId, organizationId: ctx.organizationId, userId: ctx.userId, archived });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({ template: result.template });
  }

  const result = await updateCrmEmailTemplate({ ...fields, templateId, organizationId: ctx.organizationId, userId: ctx.userId });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ template: result.template });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ templateId: string }> }) {
  const [{ error, ctx }, { templateId }] = await Promise.all([requireCrmDelete(req), params]);
  if (error) return error;

  const result = await setCrmEmailTemplateArchived({ templateId, organizationId: ctx.organizationId, userId: ctx.userId, archived: true });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ template: result.template });
}
