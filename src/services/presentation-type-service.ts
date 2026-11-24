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
  DELETED_PRESENTATION_TYPE_KEYS_SETTING,
  PRESENTATION_TYPES_SETTING,
  readDeletedPresentationTypeKeys,
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
 * How many abstracts and reviews of the organisation hold each key: an
 * abstract whose decision OR whose author's request is the key (once, even
 * when both are), plus reviews recommending it. One count per key (at most
 * MAX_PRESENTATION_TYPES): the first version summed group counts and
 * subtracted "both columns set", which also subtracted every abstract whose
 * two columns held DIFFERENT keys, so a type staff had moved abstracts to
 * read as unused and could be deleted (review of 6e04916ec).
 * Through the abstract's EVENT, not the row's own organisation stamp, which
 * older rows may lack. Inside the caller's lane: under a row policy, a read
 * outside it would see nothing, and a type in use would look free to delete.
 */
async function countUse(tx: Tx, organizationId: string, keys: string[]): Promise<Map<string, number>> {
  const use = new Map<string, number>();
  // One after another: an interactive transaction runs its queries in turn anyway.
  for (const key of keys) {
    const abstracts = await tx.abstract.count({
      where: { event: { organizationId }, OR: [{ presentationType: key }, { requestedPresentationType: key }] },
    });
    const reviews = await tx.abstractReviewSubmission.count({ where: { abstract: { event: { organizationId } }, recommendedFormat: key } });
    use.set(key, abstracts + reviews);
  }
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
      const deleted = readDeletedPresentationTypeKeys(settings);
      const use = await countUse(tx, organizationId, before.map((t) => t.key));
      const inUse = change.action === "delete" ? (use.get(change.key) ?? 0) : 0;
      const applied = applyPresentationTypeChange(before, change, inUse, deleted);
      if (!applied.ok) return { saved: false, result: applied };
      // A deleted type's key is kept, so no new type ever takes it.
      const nextDeleted = change.action === "delete" ? [...new Set([...deleted, change.key])] : deleted;
      await tx.organization.update({
        where: { id: organizationId },
        data: {
          settings: {
            ...settings,
            [PRESENTATION_TYPES_SETTING]: storedPresentationTypes(applied.types),
            ...(nextDeleted.length > 0 && { [DELETED_PRESENTATION_TYPE_KEYS_SETTING]: nextDeleted }),
          } as unknown as Prisma.InputJsonValue,
        },
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
