/** PATCH or DELETE a template line (admin). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { upsertTemplateLineSchema } from "@/procurement/lib/budget-schemas";
import { procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { deleteTemplateLine, upsertTemplateLine } from "@/procurement/services/budget-template-service";

const STATUS: Record<string, number> = { TEMPLATE_NOT_FOUND: 404, LINE_NOT_FOUND: 404, CATEGORY_NOT_FOUND: 404, INVALID_AMOUNT: 400, UNKNOWN: 500 };
type Params = { params: Promise<{ templateId: string; lineId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const [g, { templateId, lineId }] = await Promise.all([procurementGuard({ route: "procurement/templates/[templateId]/lines/[lineId]", need: "admin", write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = upsertTemplateLineSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/templates/[templateId]/lines/[lineId]", userId: g.user.id, templateId, lineId });
  return runWithTenant(g.orgId, async () => {
    const result = await upsertTemplateLine({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", templateId, lineId, ...parsed.data });
    if (!result.ok) return rejected("procurement/templates/[templateId]/lines/[lineId]", g.user.id, result, STATUS);
    return NextResponse.json({ template: result.template });
  });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const [g, { templateId, lineId }] = await Promise.all([procurementGuard({ route: "procurement/templates/[templateId]/lines/[lineId]", need: "admin", write: true }), params]);
  if (!g.ok) return g.response;
  return runWithTenant(g.orgId, async () => {
    const result = await deleteTemplateLine({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", templateId, lineId });
    if (!result.ok) return rejected("procurement/templates/[templateId]/lines/[lineId]", g.user.id, result, STATUS);
    return NextResponse.json({ template: result.template });
  });
}
