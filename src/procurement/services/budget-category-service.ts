/**
 * Budget categories: the per-organisation catalogue every budget line keys on.
 *
 * `ensureBudgetCategories` seeds the chart-of-accounts groups ONCE per organisation (the
 * CRM pipeline-stage pattern): an organisation that already holds categories,
 * even after archiving some, is never re-seeded, so an admin's edits stand.
 * The seed is idempotent under concurrency because `@@unique([organizationId,
 * code])` backs `skipDuplicates`.
 *
 * Errors as values (src/services/README.md). Runs inside the caller's tenant
 * lane; it never opens one itself.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  BUDGET_CATEGORY_CODE_RE,
  BUDGET_CATEGORY_MAX_DEPTH,
  BUDGET_CATEGORY_SEED,
} from "../lib/budget-categories-seed";

export const BUDGET_CATEGORY_SELECT = {
  id: true,
  code: true,
  name: true,
  type: true,
  parentId: true,
  depth: true,
  sortOrder: true,
  isActive: true,
} as const;

export type BudgetCategoryErrorCode =
  | "INVALID_CODE"
  | "CODE_TAKEN"
  | "PARENT_NOT_FOUND"
  | "TOO_DEEP"
  | "CATEGORY_NOT_FOUND"
  | "CATEGORY_IN_USE"
  | "UNKNOWN";

export type BudgetCategoryResult<T> =
  | { ok: true; category: T }
  | { ok: false; code: BudgetCategoryErrorCode; message: string };

export async function ensureBudgetCategories(organizationId: string) {
  const existing = await db.budgetCategory.findMany({
    where: { organizationId },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    select: BUDGET_CATEGORY_SELECT,
  });
  if (existing.length > 0) return existing;
  try {
    await db.budgetCategory.createMany({
      data: BUDGET_CATEGORY_SEED.map((c, i) => ({
        organizationId,
        code: c.code,
        name: c.name,
        type: "EXPENSE" as const,
        depth: 0,
        sortOrder: i,
        isActive: c.active ?? true,
      })),
      skipDuplicates: true,
    });
    apiLogger.info({ msg: "procurement/categories:seeded", organizationId, count: BUDGET_CATEGORY_SEED.length });
  } catch (err) {
    apiLogger.warn({ msg: "procurement/categories:seed-raced", organizationId, err });
  }
  return db.budgetCategory.findMany({
    where: { organizationId },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    select: BUDGET_CATEGORY_SELECT,
  });
}

export interface CreateBudgetCategoryInput {
  organizationId: string;
  actorUserId: string;
  source: "ui" | "mcp";
  code: string;
  name: string;
  parentId?: string | null;
  type?: "EXPENSE" | "REVENUE";
}

export async function createBudgetCategory(input: CreateBudgetCategoryInput) {
  const code = input.code.trim().toUpperCase();
  if (!BUDGET_CATEGORY_CODE_RE.test(code)) {
    return fail("INVALID_CODE", "A category code is A-Z and digits, with up to two dot-separated levels (VENUE.AV).");
  }
  let depth = 0;
  if (input.parentId) {
    const parent = await db.budgetCategory.findFirst({
      where: { id: input.parentId, organizationId: input.organizationId },
      select: { id: true, depth: true, code: true },
    });
    if (!parent) return fail("PARENT_NOT_FOUND", "The parent category was not found.");
    depth = parent.depth + 1;
    if (depth >= BUDGET_CATEGORY_MAX_DEPTH) return fail("TOO_DEEP", "Categories nest at most three levels deep.");
    if (!code.startsWith(parent.code + ".")) {
      return fail("INVALID_CODE", `A child code must start with its parent's code (${parent.code}.).`);
    }
  }
  try {
    const last = await db.budgetCategory.aggregate({ where: { organizationId: input.organizationId }, _max: { sortOrder: true } });
    const category = await db.budgetCategory.create({
      data: {
        organizationId: input.organizationId,
        code,
        name: input.name.trim(),
        type: input.type ?? "EXPENSE",
        parentId: input.parentId ?? null,
        depth,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
      select: BUDGET_CATEGORY_SELECT,
    });
    await db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          organizationId: input.organizationId,
          action: "CREATE",
          entityType: "BudgetCategory",
          entityId: category.id,
          changes: { source: input.source, code, name: category.name, parentId: input.parentId ?? null },
        },
      })
      .catch((err) => apiLogger.error({ msg: "procurement/categories:audit-failed", err }));
    return { ok: true as const, category };
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return fail("CODE_TAKEN", `Category code ${code} already exists.`);
    apiLogger.error({ msg: "procurement/categories:create-failed", err });
    return fail("UNKNOWN", "Could not create the category.");
  }
}

export async function archiveBudgetCategory(input: { organizationId: string; actorUserId: string; categoryId: string; active: boolean }) {
  const cat = await db.budgetCategory.findFirst({
    where: { id: input.categoryId, organizationId: input.organizationId },
    select: { id: true, code: true, isActive: true },
  });
  if (!cat) return fail("CATEGORY_NOT_FOUND", "The category was not found.");
  if (cat.isActive === input.active) return { ok: true as const, category: cat };
  const updated = await db.budgetCategory.updateMany({
    where: { id: input.categoryId, organizationId: input.organizationId },
    data: { isActive: input.active },
  });
  if (updated.count === 0) return fail("CATEGORY_NOT_FOUND", "The category was not found.");
  await db.auditLog
    .create({
      data: {
        userId: input.actorUserId,
        organizationId: input.organizationId,
        action: input.active ? "RESTORE" : "ARCHIVE",
        entityType: "BudgetCategory",
        entityId: input.categoryId,
        changes: { code: cat.code, isActive: input.active },
      },
    })
    .catch((err) => apiLogger.error({ msg: "procurement/categories:audit-failed", err }));
  return { ok: true as const, category: { ...cat, isActive: input.active } };
}

function fail(code: BudgetCategoryErrorCode, message: string) {
  apiLogger.warn({ msg: "procurement/categories:rejected", code, message });
  return { ok: false as const, code, message };
}
