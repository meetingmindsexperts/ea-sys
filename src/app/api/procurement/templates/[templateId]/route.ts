/** PATCH a template's name, type, description or active flag (admin). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { patchTemplateSchema } from "@/procurement/lib/budget-schemas";
import { procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { updateBudgetTemplate } from "@/procurement/services/budget-template-service";

const STATUS: Record<string, number> = { TEMPLATE_NOT_FOUND: 404, NAME_TAKEN: 409, UNKNOWN: 500 };

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ templateId: string }> }) {
  const [g, { templateId }] = await Promise.all([procurementGuard({ route: "procurement/templates/[templateId]", need: "admin", write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = patchTemplateSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/templates/[templateId]", userId: g.user.id, templateId });
  return runWithTenant(g.orgId, async () => {
    const result = await updateBudgetTemplate({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", templateId, ...parsed.data });
    if (!result.ok) return rejected("procurement/templates/[templateId]", g.user.id, result, STATUS);
    return NextResponse.json({ template: result.template });
  });
}
