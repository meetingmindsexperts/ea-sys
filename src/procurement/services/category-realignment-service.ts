/**
 * Executes the chart-of-accounts category realignment for one organisation
 * (plan: src/procurement/lib/category-realignment.ts). Reads what the plan
 * needs, and with `write` applies it in ONE transaction: a refusal, or any
 * failure midway, leaves the organisation exactly as it was.
 *
 * Deleting an old category is the last step and is a hard delete: nothing
 * points at it by then, and SpendRequest / CommitmentLine carry `SetNull`
 * foreign keys, which is why the plan refuses outright when either one uses
 * an old category rather than letting the delete quietly blank them.
 *
 * Runs inside the caller's tenant lane (the script opens one per organisation).
 */
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { LEGACY_BUDGET_CATEGORY_CODES } from "../lib/budget-categories-seed";
import { isPlanEmpty, planCategoryRealignment, type RealignPlan, type RealignReferences } from "../lib/category-realignment";

export interface RealignResult {
  plan: RealignPlan;
  /** True only when `write` was set and the transaction committed. */
  applied: boolean;
  /** Nothing to change: already on the chart. */
  alreadyAligned: boolean;
}

export async function realignBudgetCategories(organizationId: string, opts: { write: boolean }): Promise<RealignResult> {
  const [categories, products, templates, budgets] = await Promise.all([
    db.budgetCategory.findMany({ where: { organizationId }, select: { id: true, code: true, name: true, sortOrder: true, type: true } }),
    db.budgetProduct.findMany({ where: { organizationId }, select: { id: true, sku: true, categoryId: true } }),
    db.budgetTemplate.findMany({ where: { organizationId }, select: { id: true, name: true, lines: { select: { id: true, categoryId: true, defaultQty: true, defaultUnitCost: true } } } }),
    db.eventBudget.findMany({ where: { organizationId }, select: { naCategoryCodes: true } }),
  ]);
  const legacyIds = categories.filter((c) => LEGACY_BUDGET_CATEGORY_CODES.has(c.code)).map((c) => c.id);
  const references = new Map<string, RealignReferences>();
  if (legacyIds.length > 0) {
    // Soft-deleted budget lines count: their foreign key still points at the category.
    const [lines, requests, poLines] = await Promise.all([
      db.budgetLine.groupBy({ by: ["categoryId"], where: { organizationId, categoryId: { in: legacyIds } }, _count: { _all: true } }),
      db.spendRequest.groupBy({ by: ["categoryId"], where: { organizationId, categoryId: { in: legacyIds } }, _count: { _all: true } }),
      db.commitmentLine.groupBy({ by: ["categoryId"], where: { organizationId, categoryId: { in: legacyIds } }, _count: { _all: true } }),
    ]);
    const bump = (id: string | null, key: keyof RealignReferences, n: number) => {
      if (!id) return;
      const cur = references.get(id) ?? { budgetLines: 0, spendRequests: 0, commitmentLines: 0 };
      cur[key] += n;
      references.set(id, cur);
    };
    for (const r of lines) bump(r.categoryId, "budgetLines", r._count._all);
    for (const r of requests) bump(r.categoryId, "spendRequests", r._count._all);
    for (const r of poLines) bump(r.categoryId, "commitmentLines", r._count._all);
  }
  const plan = planCategoryRealignment({ categories, products, templates, references, naCategoryCodes: budgets.flatMap((b) => b.naCategoryCodes) });
  const alreadyAligned = isPlanEmpty(plan);
  if (alreadyAligned || !opts.write) return { plan, applied: false, alreadyAligned };
  if (plan.blocked.length > 0) {
    apiLogger.warn({ msg: "procurement/categories:realign-blocked", organizationId, blocked: plan.blocked });
    return { plan, applied: false, alreadyAligned };
  }

  await tenantTransaction(
    async (tx) => {
      if (plan.createCategories.length > 0) {
        await tx.budgetCategory.createMany({
          data: plan.createCategories.map((c) => ({ organizationId, code: c.code, name: c.name, type: "EXPENSE" as const, depth: 0, sortOrder: c.sortOrder, isActive: c.isActive })),
        });
      }
      for (const u of plan.sortUpdates) {
        await tx.budgetCategory.updateMany({ where: { id: u.categoryId, organizationId }, data: { sortOrder: u.sortOrder } });
      }
      const now = await tx.budgetCategory.findMany({ where: { organizationId, type: "EXPENSE" }, select: { id: true, code: true, name: true } });
      const byCode = new Map(now.map((c) => [c.code, c]));
      const target = (code: string) => {
        const c = byCode.get(code);
        if (!c) throw new Error(`Category ${code} missing after create`);
        return c;
      };

      const movesByGroup = new Map<string, string[]>();
      for (const m of plan.productMoves) movesByGroup.set(m.toCode, [...(movesByGroup.get(m.toCode) ?? []), m.productId]);
      for (const [code, ids] of movesByGroup) {
        await tx.budgetProduct.updateMany({ where: { id: { in: ids }, organizationId }, data: { categoryId: target(code).id } });
      }

      for (const t of plan.templateRebuilds) {
        await tx.budgetTemplateLine.deleteMany({ where: { id: { in: t.removeLineIds }, templateId: t.templateId, organizationId } });
        const last = await tx.budgetTemplateLine.aggregate({ where: { templateId: t.templateId }, _max: { sortOrder: true } });
        const start = (last._max.sortOrder ?? -1) + 1;
        await tx.budgetTemplateLine.createMany({
          data: t.addGroupCodes.map((code, i) => ({ organizationId, templateId: t.templateId, categoryId: target(code).id, description: target(code).name, sortOrder: start + i })),
        });
      }

      if (plan.deleteCategories.length > 0) {
        await tx.budgetCategory.deleteMany({ where: { id: { in: plan.deleteCategories.map((c) => c.categoryId) }, organizationId } });
      }

      await tx.auditLog.create({
        data: {
          userId: null,
          organizationId,
          action: "REALIGN",
          entityType: "BudgetCategory",
          entityId: organizationId,
          changes: {
            source: "script",
            created: plan.createCategories.map((c) => c.code),
            removed: plan.deleteCategories.map((c) => c.code),
            productsMoved: plan.productMoves.length,
            templatesRebuilt: plan.templateRebuilds.length,
          },
        },
      });
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  apiLogger.info({
    msg: "procurement/categories:realigned",
    organizationId,
    created: plan.createCategories.length,
    removed: plan.deleteCategories.length,
    productsMoved: plan.productMoves.length,
    templatesRebuilt: plan.templateRebuilds.length,
  });
  return { plan, applied: true, alreadyAligned };
}
