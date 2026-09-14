/**
 * Budget products: the organisation's cost catalogue a budget line is picked
 * from. `ensureBudgetProducts` seeds the MME list ONCE per organisation (the
 * category pattern): an organisation that already holds products, even after
 * archiving some, is never re-seeded, so an admin's edits stand. Seeding is
 * idempotent under concurrency because `@@unique([organizationId, sku])`
 * backs `skipDuplicates`. Items are archived, never deleted: a line keeps its
 * link (and its SKU for the accounting mapping) after the item leaves the
 * picker.
 *
 * Errors as values (src/services/README.md). Runs inside the caller's tenant
 * lane; it never opens one itself.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { BUDGET_PRODUCT_SEED, BUDGET_PRODUCT_SKU_RE } from "../lib/budget-products-seed";
import { ensureBudgetCategories } from "./budget-category-service";

export const BUDGET_PRODUCT_SELECT = {
  id: true,
  sku: true,
  name: true,
  categoryId: true,
  isActive: true,
  sortOrder: true,
  category: { select: { id: true, code: true, name: true } },
} as const;

export type BudgetProductErrorCode = "INVALID_SKU" | "SKU_TAKEN" | "CATEGORY_NOT_FOUND" | "PRODUCT_NOT_FOUND" | "UNKNOWN";

export type BudgetProductResult<T> =
  | { ok: true; product: T }
  | { ok: false; code: BudgetProductErrorCode; message: string };

type Source = "ui" | "mcp";

function list(organizationId: string) {
  return db.budgetProduct.findMany({
    where: { organizationId },
    orderBy: [{ sortOrder: "asc" }, { sku: "asc" }],
    select: BUDGET_PRODUCT_SELECT,
  });
}

export async function ensureBudgetProducts(organizationId: string) {
  const existing = await list(organizationId);
  if (existing.length > 0) return existing;
  const categories = await ensureBudgetCategories(organizationId);
  const idByCode = new Map(categories.map((c) => [c.code, c.id]));
  const skipped: string[] = [];
  const data = BUDGET_PRODUCT_SEED.flatMap((p, i) => {
    const categoryId = idByCode.get(p.category);
    if (!categoryId) {
      skipped.push(p.sku);
      return [];
    }
    return [{ organizationId, sku: p.sku, name: p.name, categoryId, isActive: p.active ?? true, sortOrder: i }];
  });
  try {
    await db.budgetProduct.createMany({ data, skipDuplicates: true });
    apiLogger.info({ msg: "procurement/products:seeded", organizationId, count: data.length });
    if (skipped.length) apiLogger.warn({ msg: "procurement/products:seed-skipped-unknown-category", organizationId, skipped });
  } catch (err) {
    apiLogger.warn({ msg: "procurement/products:seed-raced", organizationId, err });
  }
  return list(organizationId);
}

async function activeCategory(organizationId: string, categoryId: string) {
  return db.budgetCategory.findFirst({ where: { id: categoryId, organizationId, isActive: true }, select: { id: true, code: true } });
}

export interface CreateBudgetProductInput {
  organizationId: string;
  actorUserId: string;
  source: Source;
  sku: string;
  name: string;
  categoryId: string;
}

export async function createBudgetProduct(input: CreateBudgetProductInput) {
  const sku = input.sku.trim();
  if (!BUDGET_PRODUCT_SKU_RE.test(sku)) return fail("INVALID_SKU", "A SKU is letters, digits, dots, dashes or underscores, up to 40 characters.");
  const category = await activeCategory(input.organizationId, input.categoryId);
  if (!category) return fail("CATEGORY_NOT_FOUND", "The category was not found or is archived.");
  try {
    const last = await db.budgetProduct.aggregate({ where: { organizationId: input.organizationId }, _max: { sortOrder: true } });
    const product = await db.budgetProduct.create({
      data: { organizationId: input.organizationId, sku, name: input.name.trim(), categoryId: category.id, sortOrder: (last._max.sortOrder ?? -1) + 1 },
      select: BUDGET_PRODUCT_SELECT,
    });
    await db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          organizationId: input.organizationId,
          action: "CREATE",
          entityType: "BudgetProduct",
          entityId: product.id,
          changes: { source: input.source, sku, name: product.name, categoryCode: category.code },
        },
      })
      .catch((err) => apiLogger.error({ msg: "procurement/products:audit-failed", err }));
    return { ok: true as const, product };
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return fail("SKU_TAKEN", `SKU ${sku} already exists.`);
    apiLogger.error({ msg: "procurement/products:create-failed", err });
    return fail("UNKNOWN", "Could not create the product.");
  }
}

export interface UpdateBudgetProductInput {
  organizationId: string;
  actorUserId: string;
  source: Source;
  productId: string;
  name?: string;
  categoryId?: string;
  isActive?: boolean;
}

export async function updateBudgetProduct(input: UpdateBudgetProductInput) {
  const before = await db.budgetProduct.findFirst({
    where: { id: input.productId, organizationId: input.organizationId },
    select: BUDGET_PRODUCT_SELECT,
  });
  if (!before) return fail("PRODUCT_NOT_FOUND", "The product was not found.");
  let categoryCode: string | null = null;
  if (input.categoryId !== undefined && input.categoryId !== before.categoryId) {
    const category = await activeCategory(input.organizationId, input.categoryId);
    if (!category) return fail("CATEGORY_NOT_FOUND", "The category was not found or is archived.");
    categoryCode = category.code;
  }
  const data = {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
  };
  const fields = Object.keys(data);
  if (fields.length === 0) return { ok: true as const, product: before };
  try {
    const res = await db.budgetProduct.updateMany({ where: { id: input.productId, organizationId: input.organizationId }, data });
    if (res.count === 0) return fail("PRODUCT_NOT_FOUND", "The product was not found.");
    const product = await db.budgetProduct.findFirst({ where: { id: input.productId, organizationId: input.organizationId }, select: BUDGET_PRODUCT_SELECT });
    if (!product) return fail("PRODUCT_NOT_FOUND", "The product was not found.");
    const onlyActivity = fields.length === 1 && input.isActive !== undefined;
    const action = onlyActivity ? (input.isActive ? "RESTORE" : "ARCHIVE") : "UPDATE";
    await db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          organizationId: input.organizationId,
          action,
          entityType: "BudgetProduct",
          entityId: product.id,
          changes: {
            source: input.source,
            sku: before.sku,
            fields,
            ...(input.name !== undefined ? { name: { before: before.name, after: product.name } } : {}),
            ...(categoryCode ? { categoryCode: { before: before.category.code, after: categoryCode } } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          },
        },
      })
      .catch((err) => apiLogger.error({ msg: "procurement/products:audit-failed", err }));
    return { ok: true as const, product };
  } catch (err) {
    apiLogger.error({ msg: "procurement/products:update-failed", err, productId: input.productId });
    return fail("UNKNOWN", "Could not save the product.");
  }
}

function fail(code: BudgetProductErrorCode, message: string) {
  apiLogger.warn({ msg: "procurement/products:rejected", code, message });
  return { ok: false as const, code, message };
}
