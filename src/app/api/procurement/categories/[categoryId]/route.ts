/** PATCH rename or archive/restore a category (admin). Never deleted: lines reference it. */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { patchCategorySchema } from "@/procurement/lib/budget-schemas";
import { procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { archiveBudgetCategory, BUDGET_CATEGORY_SELECT } from "@/procurement/services/budget-category-service";

const STATUS: Record<string, number> = { CATEGORY_NOT_FOUND: 404, UNKNOWN: 500 };

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ categoryId: string }> }) {
  const [g, { categoryId }] = await Promise.all([procurementGuard({ route: "procurement/categories/[categoryId]", need: "admin", write: true }), params]);
  if (!g.ok) return g.response;
  const parsed = patchCategorySchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: "procurement/categories/[categoryId]", userId: g.user.id, categoryId });
  return runWithTenant(g.orgId, async () => {
    if (parsed.data.isActive !== undefined) {
      const result = await archiveBudgetCategory({ organizationId: g.orgId, actorUserId: g.user.id, categoryId, active: parsed.data.isActive });
      if (!result.ok) return rejected("procurement/categories/[categoryId]", g.user.id, result, STATUS);
    }
    if (parsed.data.name !== undefined) {
      const res = await db.budgetCategory.updateMany({ where: { id: categoryId, organizationId: g.orgId }, data: { name: parsed.data.name } });
      if (res.count === 0) return rejected("procurement/categories/[categoryId]", g.user.id, { code: "CATEGORY_NOT_FOUND", message: "The category was not found." }, STATUS);
    }
    const category = await db.budgetCategory.findFirst({ where: { id: categoryId, organizationId: g.orgId }, select: BUDGET_CATEGORY_SELECT });
    return NextResponse.json({ category });
  });
}
