/**
 * Sponsor tiers (Oct 15, 2026): the six built-in tiers plus the organisation's
 * own, kept in `Organization.settings.sponsorTiers`. Built-ins are fixed and
 * come first; custom tiers follow in the order they were added (owner: order
 * does not matter). A sponsor stores the tier KEY, so renaming a custom tier
 * changes only its label and every sponsor on it keeps it.
 *
 * Pure and isomorphic: the server reads the settings, the client renders the
 * list it is sent. Every surface that shows or validates a tier goes through
 * here rather than a list of its own.
 */
/**
 * The standard tiers, in order. The one list: webinar.ts re-exports it as
 * SPONSOR_TIERS for the code that predates custom tiers.
 */
export const BUILT_IN_SPONSOR_TIER_KEYS = ["platinum", "gold", "silver", "bronze", "partner", "exhibitor"] as const;

export const SPONSOR_TIERS_SETTING = "sponsorTiers";
export const MAX_CUSTOM_SPONSOR_TIERS = 20;
export const MAX_SPONSOR_TIER_LABEL = 40;

export interface SponsorTierDef {
  key: string;
  label: string;
  builtIn: boolean;
}

export interface CustomSponsorTier {
  key: string;
  label: string;
}

const BUILT_IN_LABELS: Record<(typeof BUILT_IN_SPONSOR_TIER_KEYS)[number], string> = {
  platinum: "Platinum",
  gold: "Gold",
  silver: "Silver",
  bronze: "Bronze",
  partner: "Partner",
  exhibitor: "Exhibitor",
};

export const BUILT_IN_SPONSOR_TIERS: SponsorTierDef[] = BUILT_IN_SPONSOR_TIER_KEYS.map((key) => ({
  key,
  label: BUILT_IN_LABELS[key],
  builtIn: true,
}));

/** The custom tiers stored on an organisation; anything malformed is dropped. */
export function readCustomSponsorTiers(orgSettings: unknown): CustomSponsorTier[] {
  if (!orgSettings || typeof orgSettings !== "object") return [];
  const raw = (orgSettings as Record<string, unknown>)[SPONSOR_TIERS_SETTING];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) => {
    if (!t || typeof t !== "object") return [];
    const { key, label } = t as Record<string, unknown>;
    if (typeof key !== "string" || typeof label !== "string" || !key || !label) return [];
    return [{ key, label }];
  });
}

/** Built-ins first, then the organisation's own. */
export function sponsorTierList(custom: CustomSponsorTier[]): SponsorTierDef[] {
  const builtInKeys = new Set<string>(BUILT_IN_SPONSOR_TIER_KEYS);
  return [
    ...BUILT_IN_SPONSOR_TIERS,
    ...custom.filter((t) => !builtInKeys.has(t.key)).map((t) => ({ ...t, builtIn: false })),
  ];
}

/** A tier's display name; an unknown key (a deleted or legacy tier) shows as itself. */
export function sponsorTierLabel(key: string | null | undefined, tiers: SponsorTierDef[]): string {
  if (!key) return "";
  return tiers.find((t) => t.key === key)?.label ?? key;
}

/** Position in the list, for sorting; an unknown or missing tier sorts last. */
export function sponsorTierRank(key: string | null | undefined, tiers: SponsorTierDef[]): number {
  const i = key ? tiers.findIndex((t) => t.key === key) : -1;
  return i < 0 ? tiers.length : i;
}

/** The key a new custom tier gets: its label as a slug, made unique against `taken`. */
export function customSponsorTierKey(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "tier";
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
