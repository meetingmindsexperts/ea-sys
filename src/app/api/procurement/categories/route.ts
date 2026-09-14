/** GET the category catalogue (seeded on first read); POST a new category (admin). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { createCategorySchema } from "@/procurement/lib/budget-schemas";
import { procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { createBudgetCategory, ensureBudgetCategories } from "@/procurement/services/budget-category-service";

const STATUS: Record<string, number> = { INVALID_CODE: 400, CODE_TAKEN: 409, PARENT_NOT_FOUND: 404, TOO_DEEP: 400, CATEGORY_NOT_FOUND: 404, CATEGORY_IN_USE: 409, UNKNOWN: 500 };

export async function GET() {
  const g = await procurementGuard({ route: "procurement/categories", need: "view" });
  if (!g.ok) return g.response;
  return runWithTenant(g.orgId, async () => NextResponse.json({ categories: await ensureBudgetCategories(g.orgId) }));
}

export async function POST(req: NextRequest) {
  const g = await procurementGuard({ route: "procurement/categories", need: "admin", write: true });
  if (!g.ok) return g.response;
  const parsed = createCategorySchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/categories", userId: g.user.id });
  return runWithTenant(g.orgId, async () => {
    const result = await createBudgetCategory({ organizationId: g.orgId, actorUserId: g.user.id, source: "ui", ...parsed.data });
    if (!result.ok) return rejected("procurement/categories", g.user.id, result, STATUS);
    return NextResponse.json({ category: result.category }, { status: 201 });
  });
}
