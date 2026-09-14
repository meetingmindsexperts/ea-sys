/** POST a template line (admin). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { upsertTemplateLineSchema } from "@/procurement/lib/budget-schemas";
import { procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { upsertTemplateLine } from "@/procurement/services/budget-template-service";

const STATUS: Record<string, number> = { TEMPLATE_NOT_FOUND: 404, LINE_NOT_FOUND: 404, CATEGORY_NOT_FOUND: 404, INVALID_AMOUNT: 400, UNKNOWN: 500 };

export async function POST(req: NextRequest, { params }: { params: Promise<{ templateId: string }> }) {
  const [g, { templateId }] = await Promise.all([procurementGuard({ route: "procurement/templates/[templateId]/lines", need: "admin", write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = upsertTemplateLineSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/templates/[templateId]/lines", userId: g.user.id, templateId });
  return runWithTenant(g.orgId, async () => {
    const result = await upsertTemplateLine({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", templateId, ...parsed.data });
    if (!result.ok) return rejected("procurement/templates/[templateId]/lines", g.user.id, result, STATUS);
    return NextResponse.json({ template: result.template }, { status: 201 });
  });
}
