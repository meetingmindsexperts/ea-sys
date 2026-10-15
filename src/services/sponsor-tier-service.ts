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
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { updateOrganizationSettings } from "@/lib/event-settings";
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
): { ok: true; next: CustomSponsorTier[] } | { ok: false; result: SaveSponsorTiersResult } {
  if (input.length > MAX_CUSTOM_SPONSOR_TIERS) {
    return { ok: false, result: fail("TOO_MANY", `At most ${MAX_CUSTOM_SPONSOR_TIERS} custom tiers.`) };
  }
  const currentKeys = new Set(current.map((t) => t.key));
  const labelsSeen = new Set(BUILT_IN_SPONSOR_TIERS.map((t) => t.label.toLowerCase()));
  const keysTaken = new Set<string>([...BUILT_IN_SPONSOR_TIERS.map((t) => t.key), ...currentKeys]);
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

export async function saveSponsorTiers(input: {
  organizationId: string;
  actorUserId: string;
  tiers: { key?: string | null; label: string }[];
}): Promise<SaveSponsorTiersResult> {
  try {
    const org = await db.organization.findUnique({ where: { id: input.organizationId }, select: { settings: true } });
    if (!org) return fail("ORGANIZATION_NOT_FOUND", "Organisation not found");
    const current = readCustomSponsorTiers(org.settings);

    const plan = planCustomTiers(current, input.tiers);
    if (!plan.ok) return plan.result;

    const keptKeys = new Set(plan.next.map((t) => t.key));
    const removed = current.filter((t) => !keptKeys.has(t.key));
    if (removed.length > 0) {
      const counts = await db.sponsor.groupBy({
        by: ["tier"],
        // Through the event, not Sponsor.organizationId: that column is
        // optional and an older row may not carry it.
        where: { event: { organizationId: input.organizationId }, tier: { in: removed.map((t) => t.key) } },
        _count: { _all: true },
      });
      const inUse = counts.flatMap((c) => {
        const tier = removed.find((t) => t.key === c.tier);
        return tier ? [{ key: tier.key, label: tier.label, sponsors: c._count._all }] : [];
      });
      if (inUse.length > 0) {
        const names = inUse.map((t) => `${t.label} (${t.sponsors})`).join(", ");
        return fail("TIER_IN_USE", `Move the sponsors off these tiers before deleting them: ${names}.`, inUse);
      }
    }

    await updateOrganizationSettings(input.organizationId, (cur) => ({ ...cur, [SPONSOR_TIERS_SETTING]: plan.next }));
    db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          action: "UPDATE",
          entityType: "Organization",
          entityId: input.organizationId,
          changes: { sponsorTiers: { before: current, after: plan.next } } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch((err) => apiLogger.warn({ err, organizationId: input.organizationId }, "sponsor-tiers:audit-failed"));
    apiLogger.info(
      { organizationId: input.organizationId, by: input.actorUserId, count: plan.next.length, removed: removed.map((t) => t.key) },
      "sponsor-tiers:saved",
    );
    return { ok: true, tiers: sponsorTierList(plan.next) };
  } catch (err) {
    apiLogger.error({ err, organizationId: input.organizationId }, "sponsor-tiers:save-failed");
    return fail("UNKNOWN", "Failed to save sponsor tiers");
  }
}
