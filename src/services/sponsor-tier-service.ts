/**
 * The organisation's own sponsor tiers (Oct 15, 2026). Built-ins are fixed and
 * never pass through here; this replaces the CUSTOM list as a whole, like the
 * sponsors PUT does for sponsors.
 *
 * - An entry with a `key` is an existing custom tier: only its label changes,
 *   so every sponsor on it keeps it.
 * - An entry without one is new and gets a key from its label.
 * - A custom tier left out is deleted, unless a sponsor still uses it, in which
 *   case the whole save is refused and the caller is told which and how many.
 *
 * Read, plan, in-use check and write happen in ONE transaction holding the
 * organisation row lock (review of b5ce5414): planned from an unlocked read,
 * two people saving at once could drop a tier the other had just added and
 * put a sponsor on, past the in-use check. A key any sponsor still holds is
 * never handed to a new tier, so sponsors left on a removed tier can never be
 * silently adopted by a later one.
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  BUILT_IN_SPONSOR_TIERS,
  MAX_CUSTOM_SPONSOR_TIERS,
  MAX_SPONSOR_TIER_LABEL,
  SPONSOR_TIERS_SETTING,
  customSponsorTierKey,
  readCustomSponsorTiers,
  sponsorTierList,
  type CustomSponsorTier,
  type SponsorTierDef,
} from "@/lib/sponsor-tiers";

export type SaveSponsorTiersErrorCode =
  | "ORGANIZATION_NOT_FOUND"
  | "TOO_MANY"
  | "INVALID_LABEL"
  | "DUPLICATE_LABEL"
  | "UNKNOWN_TIER"
  | "TIER_IN_USE"
  | "UNKNOWN";

export interface SponsorTierInUse {
  key: string;
  label: string;
  sponsors: number;
}

export type SaveSponsorTiersResult =
  | { ok: true; tiers: SponsorTierDef[] }
  | { ok: false; code: SaveSponsorTiersErrorCode; message: string; inUse?: SponsorTierInUse[] };

const fail = (code: SaveSponsorTiersErrorCode, message: string, inUse?: SponsorTierInUse[]): SaveSponsorTiersResult => ({
  ok: false,
  code,
  message,
  ...(inUse ? { inUse } : {}),
});

/** The next custom list, or the reason the input cannot become one. */
function planCustomTiers(
  current: CustomSponsorTier[],
  input: { key?: string | null; label: string }[],
  heldKeys: string[],
): { ok: true; next: CustomSponsorTier[] } | { ok: false; result: SaveSponsorTiersResult } {
  if (input.length > MAX_CUSTOM_SPONSOR_TIERS) {
    return { ok: false, result: fail("TOO_MANY", `At most ${MAX_CUSTOM_SPONSOR_TIERS} custom tiers.`) };
  }
  const currentKeys = new Set(current.map((t) => t.key));
  const labelsSeen = new Set(BUILT_IN_SPONSOR_TIERS.map((t) => t.label.toLowerCase()));
  const keysTaken = new Set<string>([...BUILT_IN_SPONSOR_TIERS.map((t) => t.key), ...currentKeys, ...heldKeys]);
  const next: CustomSponsorTier[] = [];
  for (const entry of input) {
    const label = entry.label.trim();
    if (!label || label.length > MAX_SPONSOR_TIER_LABEL) {
      return { ok: false, result: fail("INVALID_LABEL", `A tier name needs 1 to ${MAX_SPONSOR_TIER_LABEL} characters.`) };
    }
    if (labelsSeen.has(label.toLowerCase())) {
      return { ok: false, result: fail("DUPLICATE_LABEL", `There is already a tier called "${label}".`) };
    }
    labelsSeen.add(label.toLowerCase());
    if (entry.key && !currentKeys.has(entry.key)) {
      return { ok: false, result: fail("UNKNOWN_TIER", `"${label}" refers to a tier that does not exist. Reload and try again.`) };
    }
    const key = entry.key || customSponsorTierKey(label, keysTaken);
    keysTaken.add(key);
    next.push({ key, label });
  }
  return { ok: true, next };
}

/** What the locked transaction decided: a refusal, or what it wrote. */
type TierSaveOutcome =
  | { saved: false; result: SaveSponsorTiersResult }
  | { saved: true; before: CustomSponsorTier[]; after: CustomSponsorTier[]; removed: CustomSponsorTier[] };

export async function saveSponsorTiers(input: {
  organizationId: string;
  actorUserId: string;
  tiers: { key?: string | null; label: string }[];
}): Promise<SaveSponsorTiersResult> {
  try {
    const outcome = await db.$transaction(async (tx): Promise<TierSaveOutcome> => {
      // The same row lock the settings writer takes, so this serialises with
      // every other organisation-settings change.
      const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue | null }[]>`SELECT "settings" FROM "Organization" WHERE "id" = ${input.organizationId} FOR UPDATE`;
      if (rows.length === 0) return { saved: false, result: fail("ORGANIZATION_NOT_FOUND", "Organisation not found") };
      const settings = (rows[0].settings ?? {}) as Record<string, unknown>;
      const current = readCustomSponsorTiers(settings);

      // Every tier key a sponsor in this organisation holds, counted through
      // the event (Sponsor.organizationId is optional on older rows).
      const held = await tx.sponsor.groupBy({
        by: ["tier"],
        where: { event: { organizationId: input.organizationId }, tier: { not: null } },
        _count: { _all: true },
      });
      const heldCount = new Map(held.flatMap((h) => (h.tier ? [[h.tier, h._count._all] as const] : [])));

      const plan = planCustomTiers(current, input.tiers, [...heldCount.keys()]);
      if (!plan.ok) return { saved: false, result: plan.result };

      const keptKeys = new Set(plan.next.map((t) => t.key));
      const removed = current.filter((t) => !keptKeys.has(t.key));
      const inUse = removed.flatMap((t) => {
        const sponsors = heldCount.get(t.key) ?? 0;
        return sponsors > 0 ? [{ key: t.key, label: t.label, sponsors }] : [];
      });
      if (inUse.length > 0) {
        const names = inUse.map((t) => `${t.label} (${t.sponsors})`).join(", ");
        return { saved: false, result: fail("TIER_IN_USE", `Move the sponsors off these tiers before deleting them: ${names}.`, inUse) };
      }

      await tx.organization.update({
        where: { id: input.organizationId },
        data: { settings: { ...settings, [SPONSOR_TIERS_SETTING]: plan.next } as unknown as Prisma.InputJsonValue },
      });
      return { saved: true, before: current, after: plan.next, removed };
    });

    if (!outcome.saved) return outcome.result;
    db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          action: "UPDATE",
          entityType: "Organization",
          entityId: input.organizationId,
          changes: { sponsorTiers: { before: outcome.before, after: outcome.after } } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch((err) => apiLogger.warn({ err, organizationId: input.organizationId }, "sponsor-tiers:audit-failed"));
    apiLogger.info(
      {
        organizationId: input.organizationId,
        by: input.actorUserId,
        count: outcome.after.length,
        removed: outcome.removed.map((t) => t.key),
      },
      "sponsor-tiers:saved",
    );
    return { ok: true, tiers: sponsorTierList(outcome.after) };
  } catch (err) {
    apiLogger.error({ err, organizationId: input.organizationId }, "sponsor-tiers:save-failed");
    return fail("UNKNOWN", "Failed to save sponsor tiers");
  }
}
