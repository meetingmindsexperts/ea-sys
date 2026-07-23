/**
 * CRM product/service catalog + deal line items. SERVER ONLY.
 *
 * The catalog (`CrmProduct`) is org-wide, seeded once from `crm-products-seed.ts`
 * (like the pipeline stages / email templates), then maintained via CRUD. It is
 * config, so catalog edits audit to the CORE `AuditLog` (entityType "CrmProduct")
 * like pipeline-service — NOT `CrmActivity`.
 *
 * A deal's products (`CrmDealProduct`) ARE part of the deal's story, so add/remove
 * records on the DEAL's `CrmActivity` timeline. The line's `unitPrice` is set on the
 * deal (pre-filled from the catalog list price); name/category/sku are snapshotted at
 * add-time so a later catalog edit never rewrites a deal. The deal's Value stays
 * MANUAL — the products total is informational.
 *
 * Prices (`price`, `unitPrice`) are in FINANCIAL_KEYS, so `redactForCaller` at the
 * route boundary strips them for MEMBER exactly like `dealValue`.
 */
import { Prisma, type CrmProduct, type CrmDealProduct, type CrmProductSource } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordCrmActivity } from "@/crm/lib/crm-activity";
import { CRM_PRODUCT_SEED } from "@/crm/lib/crm-products-seed";

export type CrmProductErrorCode =
  | "NAME_REQUIRED"
  | "CATEGORY_REQUIRED"
  | "PRODUCT_NOT_FOUND"
  | "PRODUCT_ARCHIVED"
  | "DEAL_NOT_FOUND"
  | "DEAL_ARCHIVED"
  | "PRODUCT_ALREADY_ON_DEAL"
  | "LINE_NOT_FOUND"
  | "UNKNOWN";

type Fail = { ok: false; code: CrmProductErrorCode; message: string };

/**
 * Log + return a business rejection. Every non-technical `return { ok: false }` goes
 * through here so no rejection is silent (the "every failure path logs" rule — the
 * sibling deal/task services all do this).
 */
function reject(code: CrmProductErrorCode, message: string, ctx: Record<string, unknown>): Fail {
  apiLogger.warn({ msg: `crm-product:${code.toLowerCase()}`, ...ctx });
  return { ok: false, code, message };
}

function writeAudit(entry: { userId: string | null; action: string; entityId: string; changes: Record<string, unknown> }) {
  return db.auditLog
    .create({
      data: {
        userId: entry.userId,
        action: entry.action,
        entityType: "CrmProduct",
        entityId: entry.entityId,
        changes: entry.changes as Prisma.InputJsonValue,
      },
    })
    .catch((err: unknown) => {
      apiLogger.error({ msg: "crm-product:audit-failed", entityId: entry.entityId, err: err instanceof Error ? err.message : String(err) });
    });
}

// ── Catalog ────────────────────────────────────────────────────────────────────

/**
 * Seed the org's catalog from the built-in list once. Idempotent under a concurrent
 * first-load: the `count === 0` gate is a fast-path, and `skipDuplicates` is the real
 * guard — the `@@unique([organizationId, sku])` index means a racing second seed skips
 * every SKU-collision instead of inserting a duplicate 131 rows (review M1). Every
 * seed row has a SKU, so all collide; manual NULL-SKU products stay distinct.
 */
export async function ensureCrmProducts(organizationId: string): Promise<void> {
  const count = await db.crmProduct.count({ where: { organizationId } });
  if (count > 0) return;
  try {
    const res = await db.crmProduct.createMany({
      data: CRM_PRODUCT_SEED.map((p, i) => ({
        organizationId,
        name: p.name,
        sku: p.sku,
        category: p.category,
        source: p.source as CrmProductSource,
        price: new Prisma.Decimal(p.price),
        currency: "AED",
        sortOrder: i,
      })),
      skipDuplicates: true,
    });
    apiLogger.info({ msg: "crm-product:seeded", organizationId, inserted: res.count });
  } catch (err) {
    apiLogger.warn({ msg: "crm-product:seed-race", organizationId, err: err instanceof Error ? err.message : String(err) });
  }
}

export async function listCrmProducts(
  organizationId: string,
  opts: { includeArchived?: boolean; category?: string; q?: string } = {},
): Promise<CrmProduct[]> {
  return db.crmProduct.findMany({
    where: {
      organizationId,
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.q
        ? { OR: [{ name: { contains: opts.q, mode: "insensitive" } }, { sku: { contains: opts.q, mode: "insensitive" } }] }
        : {}),
    },
    orderBy: [{ archivedAt: "asc" }, { category: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    take: 1000,
  });
}

export async function createCrmProduct(input: {
  organizationId: string;
  userId: string | null;
  name: string;
  sku?: string | null;
  category: string;
  source?: CrmProductSource;
  price?: number;
  priceIncludesTax?: boolean;
  currency?: string;
}): Promise<{ ok: true; product: CrmProduct } | Fail> {
  const name = input.name?.trim() ?? "";
  const category = input.category?.trim() ?? "";
  const rejCtx = { organizationId: input.organizationId };
  if (!name) return reject("NAME_REQUIRED", "Product name is required", rejCtx);
  if (!category) return reject("CATEGORY_REQUIRED", "A category is required", rejCtx);

  try {
    const product = await db.$transaction(async (tx) => {
      const agg = await tx.crmProduct.aggregate({ where: { organizationId: input.organizationId }, _max: { sortOrder: true } });
      return tx.crmProduct.create({
        data: {
          organizationId: input.organizationId,
          name,
          sku: input.sku?.trim() || null,
          category,
          source: input.source ?? "IN_HOUSE",
          price: new Prisma.Decimal(input.price ?? 0),
          priceIncludesTax: input.priceIncludesTax ?? false,
          currency: input.currency?.trim() || "AED",
          sortOrder: (agg._max.sortOrder ?? -1) + 1,
          createdById: input.userId,
        },
      });
    });
    void writeAudit({ userId: input.userId, action: "CREATE", entityId: product.id, changes: { name, category, sku: product.sku } });
    return { ok: true, product };
  } catch (err) {
    apiLogger.error({ msg: "crm-product:create-failed", organizationId: input.organizationId, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "UNKNOWN", message: "Could not create the product" };
  }
}

export async function updateCrmProduct(input: {
  productId: string;
  organizationId: string;
  userId: string | null;
  name?: string;
  sku?: string | null;
  category?: string;
  source?: CrmProductSource;
  price?: number;
  priceIncludesTax?: boolean;
  currency?: string;
}): Promise<{ ok: true; product: CrmProduct } | Fail> {
  const data: Prisma.CrmProductUpdateManyMutationInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return reject("NAME_REQUIRED", "Product name cannot be empty", { organizationId: input.organizationId, productId: input.productId });
    data.name = name;
  }
  if (input.category !== undefined) {
    const category = input.category.trim();
    if (!category) return reject("CATEGORY_REQUIRED", "Category cannot be empty", { organizationId: input.organizationId, productId: input.productId });
    data.category = category;
  }
  if (input.sku !== undefined) data.sku = input.sku?.trim() || null;
  if (input.source !== undefined) data.source = input.source;
  if (input.price !== undefined) data.price = new Prisma.Decimal(input.price);
  if (input.priceIncludesTax !== undefined) data.priceIncludesTax = input.priceIncludesTax;
  if (input.currency !== undefined) data.currency = input.currency.trim() || "AED";

  try {
    const res = await db.crmProduct.updateMany({ where: { id: input.productId, organizationId: input.organizationId }, data });
    if (res.count === 0) return reject("PRODUCT_NOT_FOUND", "Product not found", { organizationId: input.organizationId, productId: input.productId });
    const product = await db.crmProduct.findUniqueOrThrow({ where: { id: input.productId } });
    void writeAudit({ userId: input.userId, action: "UPDATE", entityId: product.id, changes: { fields: Object.keys(data) } });
    return { ok: true, product };
  } catch (err) {
    apiLogger.error({ msg: "crm-product:update-failed", productId: input.productId, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "UNKNOWN", message: "Could not update the product" };
  }
}

export async function setCrmProductArchived(input: {
  productId: string;
  organizationId: string;
  userId: string | null;
  archived: boolean;
}): Promise<{ ok: true; product: CrmProduct } | Fail> {
  try {
    const res = await db.crmProduct.updateMany({
      where: { id: input.productId, organizationId: input.organizationId },
      data: { archivedAt: input.archived ? new Date() : null },
    });
    if (res.count === 0) return reject("PRODUCT_NOT_FOUND", "Product not found", { organizationId: input.organizationId, productId: input.productId });
    const product = await db.crmProduct.findUniqueOrThrow({ where: { id: input.productId } });
    void writeAudit({ userId: input.userId, action: input.archived ? "ARCHIVE" : "RESTORE", entityId: product.id, changes: { name: product.name } });
    return { ok: true, product };
  } catch (err) {
    apiLogger.error({ msg: "crm-product:archive-failed", productId: input.productId, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "UNKNOWN", message: "Could not archive the product" };
  }
}

// ── Deal line items ──────────────────────────────────────────────────────────────

export async function listDealProducts(dealId: string, organizationId: string): Promise<CrmDealProduct[] | null> {
  const deal = await db.crmDeal.findFirst({ where: { id: dealId, organizationId }, select: { id: true } });
  if (!deal) return null;
  return db.crmDealProduct.findMany({ where: { dealId }, orderBy: { createdAt: "asc" } });
}

export async function addDealProduct(input: {
  dealId: string;
  organizationId: string;
  userId: string | null;
  crmProductId: string;
  unitPrice?: number;
  quantity?: number;
}): Promise<{ ok: true; line: CrmDealProduct } | Fail> {
  // Bind BOTH the deal and the product to the caller's org before writing.
  const [deal, product] = await Promise.all([
    db.crmDeal.findFirst({ where: { id: input.dealId, organizationId: input.organizationId }, select: { id: true, archivedAt: true } }),
    db.crmProduct.findFirst({ where: { id: input.crmProductId, organizationId: input.organizationId } }),
  ]);
  if (!deal) return reject("DEAL_NOT_FOUND", "Deal not found", { organizationId: input.organizationId, dealId: input.dealId });
  if (deal.archivedAt) return reject("DEAL_ARCHIVED", "This deal was archived — restore it before adding products", { organizationId: input.organizationId, dealId: input.dealId });
  if (!product) return reject("PRODUCT_NOT_FOUND", "Product not found", { organizationId: input.organizationId, crmProductId: input.crmProductId });
  // R2-M7: an archived catalog product is discontinued — it must not be addable
  // (at its stale list price) via a raw id or a stale picker.
  if (product.archivedAt) return reject("PRODUCT_ARCHIVED", "That product is archived — restore it in the catalog before adding it to a deal", { organizationId: input.organizationId, crmProductId: input.crmProductId });

  const existing = await db.crmDealProduct.findFirst({ where: { dealId: input.dealId, crmProductId: input.crmProductId }, select: { id: true } });
  if (existing) return reject("PRODUCT_ALREADY_ON_DEAL", "That product is already on this deal — edit its quantity instead", { organizationId: input.organizationId, dealId: input.dealId, crmProductId: input.crmProductId });

  try {
    const line = await db.crmDealProduct.create({
      data: {
        // Denormalized org for RLS-readiness — the deal is already org-bound above.
        organizationId: input.organizationId,
        dealId: input.dealId,
        crmProductId: product.id,
        // Snapshot so a later catalog rename/re-category never rewrites this deal.
        productName: product.name,
        category: product.category,
        sku: product.sku,
        // Set on the deal — pre-filled from the catalog list price when omitted.
        unitPrice: new Prisma.Decimal(input.unitPrice ?? Number(product.price)),
        currency: product.currency,
        quantity: Math.max(1, Math.trunc(input.quantity ?? 1)),
      },
    });
    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "DEAL",
      entityId: input.dealId,
      action: "PRODUCT_ADDED",
      actorId: input.userId,
      changes: { product: product.name, category: product.category },
    });
    return { ok: true, line };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // The @@unique([dealId, crmProductId]) backstop (review R2-H2): a
      // concurrent add raced past the findFirst check above — the loser's
      // constraint violation is the same business fact, not a 500.
      return reject("PRODUCT_ALREADY_ON_DEAL", "That product is already on this deal — edit its quantity instead", {
        organizationId: input.organizationId, dealId: input.dealId, crmProductId: input.crmProductId, race: true,
      });
    }
    apiLogger.error({ msg: "crm-product:deal-add-failed", dealId: input.dealId, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "UNKNOWN", message: "Could not add the product" };
  }
}

export async function updateDealProduct(input: {
  lineId: string;
  dealId: string;
  organizationId: string;
  unitPrice?: number;
  quantity?: number;
}): Promise<{ ok: true; line: CrmDealProduct } | Fail> {
  const deal = await db.crmDeal.findFirst({ where: { id: input.dealId, organizationId: input.organizationId }, select: { id: true, archivedAt: true } });
  if (!deal) return reject("DEAL_NOT_FOUND", "Deal not found", { organizationId: input.organizationId, dealId: input.dealId });
  // R2-M1: an archived deal is frozen — line items included.
  if (deal.archivedAt) return reject("DEAL_ARCHIVED", "This deal was archived — restore it before editing its products", { organizationId: input.organizationId, dealId: input.dealId });

  const data: Prisma.CrmDealProductUpdateManyMutationInput = {};
  if (input.unitPrice !== undefined) data.unitPrice = new Prisma.Decimal(input.unitPrice);
  if (input.quantity !== undefined) data.quantity = Math.max(1, Math.trunc(input.quantity));

  try {
    // Bind the line to its deal — a line id from another deal can't be edited here.
    const res = await db.crmDealProduct.updateMany({ where: { id: input.lineId, dealId: input.dealId }, data });
    if (res.count === 0) return reject("LINE_NOT_FOUND", "Line item not found", { organizationId: input.organizationId, dealId: input.dealId, lineId: input.lineId });
    const line = await db.crmDealProduct.findUniqueOrThrow({ where: { id: input.lineId } });
    return { ok: true, line };
  } catch (err) {
    apiLogger.error({ msg: "crm-product:deal-update-failed", lineId: input.lineId, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "UNKNOWN", message: "Could not update the line item" };
  }
}

export async function removeDealProduct(input: {
  lineId: string;
  dealId: string;
  organizationId: string;
  userId: string | null;
}): Promise<{ ok: true } | Fail> {
  const deal = await db.crmDeal.findFirst({ where: { id: input.dealId, organizationId: input.organizationId }, select: { id: true, archivedAt: true } });
  if (!deal) return reject("DEAL_NOT_FOUND", "Deal not found", { organizationId: input.organizationId, dealId: input.dealId });
  // R2-M1: an archived deal is frozen — line items included.
  if (deal.archivedAt) return reject("DEAL_ARCHIVED", "This deal was archived — restore it before editing its products", { organizationId: input.organizationId, dealId: input.dealId });

  try {
    const line = await db.crmDealProduct.findFirst({ where: { id: input.lineId, dealId: input.dealId } });
    if (!line) return reject("LINE_NOT_FOUND", "Line item not found", { organizationId: input.organizationId, dealId: input.dealId, lineId: input.lineId });
    // deleteMany, not delete (CRM review L4): a concurrent double-remove's loser
    // must surface as LINE_NOT_FOUND, not a P2025 falling through as UNKNOWN —
    // the pattern removeDealContact already uses.
    const res = await db.crmDealProduct.deleteMany({ where: { id: line.id, dealId: input.dealId } });
    if (res.count === 0) {
      return reject("LINE_NOT_FOUND", "Line item not found", { organizationId: input.organizationId, dealId: input.dealId, lineId: input.lineId });
    }
    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "DEAL",
      entityId: input.dealId,
      action: "PRODUCT_REMOVED",
      actorId: input.userId,
      changes: { product: line.productName },
    });
    return { ok: true };
  } catch (err) {
    apiLogger.error({ msg: "crm-product:deal-remove-failed", lineId: input.lineId, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "UNKNOWN", message: "Could not remove the line item" };
  }
}
