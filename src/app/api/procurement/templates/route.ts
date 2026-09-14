/** GET the templates (seeded per event type on first read); POST a new one (admin). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { createTemplateSchema } from "@/procurement/lib/budget-schemas";
import { procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { createBudgetTemplate, ensureBudgetTemplates } from "@/procurement/services/budget-template-service";

const STATUS: Record<string, number> = { TEMPLATE_NOT_FOUND: 404, LINE_NOT_FOUND: 404, CATEGORY_NOT_FOUND: 404, NAME_TAKEN: 409, INVALID_AMOUNT: 400, UNKNOWN: 500 };

export async function GET() {
  const g = await procurementGuard({ route: "procurement/templates", need: "view" });
  if (!g.ok) return g.response;
  return runWithTenant(g.orgId, async () => NextResponse.json({ templates: await ensureBudgetTemplates(g.orgId) }));
}

export async function POST(req: NextRequest) {
  const g = await procurementGuard({ route: "procurement/templates", need: "admin", write: true });
  if (!g.ok) return g.response;
  const parsed = createTemplateSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/templates", userId: g.user.id });
  return runWithTenant(g.orgId, async () => {
    const result = await createBudgetTemplate({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", ...parsed.data });
    if (!result.ok) return rejected("procurement/templates", g.user.id, result, STATUS);
    return NextResponse.json({ template: result.template }, { status: 201 });
  });
}
