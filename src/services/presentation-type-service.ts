/**
 * Changing the organisation's presentation types (Nov 24, 2026; step 3 of
 * docs/ABSTRACT_PRESENTATION_TYPES_PLAN.md). The rules are pure, in
 * `src/lib/abstract-presentation-types.ts` (`applyPresentationTypeChange`);
 * this runs one change on the list read under the organisation's row lock,
 * counts what holds a type before it may be deleted, and writes the audit row.
 *
 * Called by `PUT /api/organization/presentation-types` (the event Content
 * page's card). Errors as values; never imports next/server.
 */
import type { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  applyPresentationTypeChange,
  PRESENTATION_TYPES_SETTING,
  readPresentationTypes,
  storedPresentationTypes,
  type PresentationTypeChange,
  type PresentationTypeChangeRefusal,
  type PresentationTypeDef,
  type PresentationTypeWithUse,
} from "@/lib/abstract-presentation-types";
import { resetPresentationTypeCache } from "@/lib/abstract-presentation-types-server";


export type ChangePresentationTypeResult =
  | { ok: true; key: string; types: PresentationTypeWithUse[] }
  | { ok: false; code: PresentationTypeChangeRefusal | "ORGANIZATION_NOT_FOUND" | "UNKNOWN"; message: string };

type Tx = Prisma.TransactionClient | typeof db;

/**
 * How many abstracts and reviews of the organisation hold each key. An
 * abstract counts once even when both its type and its request hold it.
 * Through the abstract's EVENT, not the row's own organisation stamp, which
 * older rows may lack. Inside the caller's lane: under a row policy, a read
 * outside it would see nothing, and a type in use would look free to delete.
 */
async function countUse(tx: Tx, organizationId: string, keys: string[]): Promise<Map<string, number>> {
  const use = new Map<string, number>();
  if (keys.length === 0) return use;
  const [decided, requested, both, reviews] = await Promise.all([
    tx.abstract.groupBy({ by: ["presentationType"], where: { event: { organizationId }, presentationType: { in: keys } }, _count: { _all: true } }),
    tx.abstract.groupBy({ by: ["requestedPresentationType"], where: { event: { organizationId }, requestedPresentationType: { in: keys } }, _count: { _all: true } }),
    // Abstracts whose type and request are the same key: counted once.
    tx.abstract.groupBy({
      by: ["presentationType"],
      where: { event: { organizationId }, presentationType: { in: keys }, requestedPresentationType: { in: keys } },
      _count: { _all: true },
    }),
    tx.abstractReviewSubmission.groupBy({ by: ["recommendedFormat"], where: { abstract: { event: { organizationId } }, recommendedFormat: { in: keys } }, _count: { _all: true } }),
  ]);
  const add = (key: string | null, n: number) => {
    if (key) use.set(key, (use.get(key) ?? 0) + n);
  };
  decided.forEach((r) => add(r.presentationType, r._count._all));
  requested.forEach((r) => add(r.requestedPresentationType, r._count._all));
  // Subtract the abstracts counted twice (same key in both columns).
  both.forEach((r) => add(r.presentationType, -r._count._all));
  reviews.forEach((r) => add(r.recommendedFormat, r._count._all));
  return use;
}

/** The organisation's list with what holds each type, for the editor. Call inside the organisation's lane. */
export async function listPresentationTypesWithUse(organizationId: string): Promise<PresentationTypeWithUse[] | null> {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  if (!org) return null;
  const types = readPresentationTypes(org.settings);
  const use = await countUse(db, organizationId, types.map((t) => t.key));
  return types.map((t) => ({ ...t, inUse: use.get(t.key) ?? 0 }));
}

type Outcome =
  | { saved: false; result: ChangePresentationTypeResult }
  | { saved: true; key: string; before: PresentationTypeDef[]; after: PresentationTypeDef[]; use: Map<string, number> };

export async function changePresentationType(input: {
  organizationId: string;
  actorUserId: string;
  change: PresentationTypeChange;
  source: "rest" | "mcp";
}): Promise<ChangePresentationTypeResult> {
  const { organizationId, change } = input;
  try {
    const outcome = await tenantTransaction(async (tx): Promise<Outcome> => {
      const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue | null }[]>`SELECT "settings" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;
      if (rows.length === 0) return { saved: false, result: { ok: false, code: "ORGANIZATION_NOT_FOUND", message: "Organisation not found" } };
      const settings = (rows[0].settings ?? {}) as Record<string, unknown>;
      const before = readPresentationTypes(settings);
      const use = await countUse(tx, organizationId, before.map((t) => t.key));
      const inUse = change.action === "delete" ? (use.get(change.key) ?? 0) : 0;
      const applied = applyPresentationTypeChange(before, change, inUse);
      if (!applied.ok) return { saved: false, result: applied };
      await tx.organization.update({
        where: { id: organizationId },
        data: { settings: { ...settings, [PRESENTATION_TYPES_SETTING]: storedPresentationTypes(applied.types) } as unknown as Prisma.InputJsonValue },
      });
      return { saved: true, key: applied.key, before, after: applied.types, use };
    });

    if (!outcome.saved) {
      apiLogger.warn({ msg: "presentation-types:change-refused", organizationId, change, code: outcome.result.ok ? undefined : outcome.result.code, source: input.source });
      return outcome.result;
    }
    // Every reader in this process sees the change at once; another process within READER_CACHE_MS.
    resetPresentationTypeCache();
    const names = (list: PresentationTypeDef[]) => list.map((t) => `${t.key}:${t.label}${t.retired ? " (retired)" : ""}`);
    db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          organizationId,
          action: "UPDATE",
          entityType: "Organization",
          entityId: organizationId,
          changes: { presentationTypes: { change, before: names(outcome.before), after: names(outcome.after) }, source: input.source } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch((err) => apiLogger.warn({ err, organizationId }, "presentation-types:audit-failed"));
    apiLogger.info({ msg: "presentation-types:changed", organizationId, by: input.actorUserId, action: change.action, key: outcome.key, source: input.source });
    return {
      ok: true,
      key: outcome.key,
      types: outcome.after.map((t) => ({ ...t, inUse: outcome.use.get(t.key) ?? 0 })),
    };
  } catch (err) {
    apiLogger.error({ err, organizationId, change, msg: "presentation-types:change-failed" });
    return { ok: false, code: "UNKNOWN", message: "Could not save the presentation types. Try again." };
  }
}
