/**
 * CRM deal-type service — the org-configurable business-line list ("Conference
 * Management", "Sponsorship Inquiry", …) shown as a dropdown on the deal and
 * managed in Settings → CRM → Deal Types.
 *
 * Same managed-list shape as pipeline-service (per-org, named, ordered, seeded on
 * first use) minus the terminal/outcome machinery — a deal type is a pure
 * classifier, it does not drive the board. "Remove" is a SOFT delete
 * (archivedAt): archived types drop out of the picker + filter but the row stays,
 * so a deal that already references one still renders its name (and a hard delete
 * would only SetNull the deal's dealTypeId — never block).
 *
 * Every by-id mutation is compound-where `{ id, organizationId }` (defence #1,
 * atomic with the write) so a cross-org id can never be touched — the RLS policy
 * (defence #2) is deferred into the CRM app-wiring sweep, but the app-layer bind
 * lands with the model.
 *
 * Errors-as-values; conventions: src/services/README.md.
 */
import { Prisma, type CrmDealType } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/** Seeded on an org's first CRM load — the MMG business lines (editable after). */
export const DEFAULT_DEAL_TYPES: readonly string[] = [
  "Conference Management",
  "Stand Alone Event",
  "In-person Event Management",
  "Exhibitor Inquiry",
  "Sponsorship Inquiry",
  "Industry Symposium",
  "Virtual Event Management",
  "Partnership Event",
  "Advisory Board Meeting",
  "Digital Marketing Campaign",
  "Experts Tour",
  "Medical Communication Services",
];

export type DealTypeErrorCode = "DEAL_TYPE_NOT_FOUND" | "NAME_REQUIRED" | "NAME_TAKEN" | "NO_FIELDS" | "UNKNOWN";

type Fail = { ok: false; code: DealTypeErrorCode; message: string; meta?: Record<string, unknown> };

/**
 * Idempotently ensure the org has a deal-type list. Safe on every load: once any
 * type exists it's a single indexed read. Does NOT re-seed a curated list (the
 * presence of ANY type means the org owns its list) — same rule as
 * ensurePipelineStages. Archived-but-present types count as "owns the list".
 */
export async function ensureDealTypes(organizationId: string): Promise<CrmDealType[]> {
  const existing = await db.crmDealType.findMany({
    where: { organizationId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  if (existing.length > 0) return existing;

  try {
    await db.crmDealType.createMany({
      data: DEFAULT_DEAL_TYPES.map((name, i) => ({ organizationId, name, sortOrder: i })),
      // @@unique([organizationId, name]) makes this a real skip under a concurrent
      // first-load (two racers both pass the length===0 fast-path).
      skipDuplicates: true,
    });
    apiLogger.info({ msg: "crm-deal-type:seeded", organizationId, count: DEFAULT_DEAL_TYPES.length });
  } catch (err) {
    apiLogger.warn({
      msg: "crm-deal-type:seed-raced",
      organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return db.crmDealType.findMany({
    where: { organizationId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

/** List the org's deal types. `includeArchived` for the management screen. */
export async function listDealTypes(organizationId: string, includeArchived = false): Promise<CrmDealType[]> {
  return db.crmDealType.findMany({
    where: { organizationId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

/** Resolve a deal-type id bound to the org — null if it isn't this org's. */
export async function resolveDealType(id: string, organizationId: string): Promise<CrmDealType | null> {
  return db.crmDealType.findFirst({ where: { id, organizationId } });
}

export async function createDealType(input: {
  organizationId: string;
  name: string;
}): Promise<{ ok: true; dealType: CrmDealType } | Fail> {
  const name = input.name?.trim() ?? "";
  if (!name) {
    apiLogger.warn({ msg: "crm-deal-type:create-name-required", organizationId: input.organizationId });
    return { ok: false, code: "NAME_REQUIRED", message: "Deal type name is required" };
  }

  try {
    // New types append to the end of the list — max(sortOrder)+1 computed in the
    // same statement family (the create-time race is settled by the unique).
    const last = await db.crmDealType.aggregate({
      where: { organizationId: input.organizationId },
      _max: { sortOrder: true },
    });
    const dealType = await db.crmDealType.create({
      data: {
        organizationId: input.organizationId,
        name,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    });
    apiLogger.info({ msg: "crm-deal-type:created", organizationId: input.organizationId, dealTypeId: dealType.id });
    return { ok: true, dealType };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      apiLogger.warn({ msg: "crm-deal-type:create-name-taken", organizationId: input.organizationId, name });
      return { ok: false, code: "NAME_TAKEN", message: "A deal type with that name already exists" };
    }
    apiLogger.error({
      msg: "crm-deal-type:create-failed",
      organizationId: input.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not create the deal type" };
  }
}

export async function updateDealType(input: {
  dealTypeId: string;
  organizationId: string;
  name?: string;
  /** Restore a soft-deleted type (archivedAt → null) or archive it. */
  archived?: boolean;
}): Promise<{ ok: true; dealType: CrmDealType } | Fail> {
  const data: Prisma.CrmDealTypeUpdateManyMutationInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { ok: false, code: "NAME_REQUIRED", message: "Deal type name cannot be empty" };
    data.name = name;
  }
  if (input.archived !== undefined) data.archivedAt = input.archived ? new Date() : null;

  if (Object.keys(data).length === 0) {
    return { ok: false, code: "NO_FIELDS", message: "Nothing to update" };
  }

  try {
    // Compound-where: a cross-org id affects zero rows → NOT_FOUND, never touches
    // another tenant's type.
    const res = await db.crmDealType.updateMany({
      where: { id: input.dealTypeId, organizationId: input.organizationId },
      data,
    });
    if (res.count === 0) {
      apiLogger.warn({ msg: "crm-deal-type:update-not-found", dealTypeId: input.dealTypeId, organizationId: input.organizationId });
      return { ok: false, code: "DEAL_TYPE_NOT_FOUND", message: "Deal type not found" };
    }
    const dealType = await db.crmDealType.findUniqueOrThrow({ where: { id: input.dealTypeId } });
    apiLogger.info({ msg: "crm-deal-type:updated", dealTypeId: dealType.id, organizationId: input.organizationId });
    return { ok: true, dealType };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      apiLogger.warn({ msg: "crm-deal-type:update-name-taken", dealTypeId: input.dealTypeId });
      return { ok: false, code: "NAME_TAKEN", message: "A deal type with that name already exists" };
    }
    apiLogger.error({
      msg: "crm-deal-type:update-failed",
      dealTypeId: input.dealTypeId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not update the deal type" };
  }
}

/**
 * Reorder the org's deal types. Takes the full ordered list of ids; each row's
 * sortOrder becomes its index. Ids not belonging to the org are ignored (the
 * compound-where per update makes a foreign id a no-op), and the whole set is
 * written in one transaction.
 */
export async function reorderDealTypes(input: {
  organizationId: string;
  orderedIds: string[];
}): Promise<{ ok: true } | Fail> {
  try {
    // Array-form $transaction can't carry the RLS SET LOCAL — run as an
    // interactive tenantTransaction (sequential; same single-tx semantics). Each
    // write stays compound-where'd { id, organizationId } so a foreign id is a
    // no-op (defence #1).
    await tenantTransaction(async (tx) => {
      for (let i = 0; i < input.orderedIds.length; i++) {
        await tx.crmDealType.updateMany({
          where: { id: input.orderedIds[i], organizationId: input.organizationId },
          data: { sortOrder: i },
        });
      }
    });
    apiLogger.info({ msg: "crm-deal-type:reordered", organizationId: input.organizationId, count: input.orderedIds.length });
    return { ok: true };
  } catch (err) {
    apiLogger.error({
      msg: "crm-deal-type:reorder-failed",
      organizationId: input.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not reorder the deal types" };
  }
}
