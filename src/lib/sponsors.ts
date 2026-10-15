/**
 * Sponsors, read from the `Sponsor` TABLE.
 *
 * Promoted out of `Event.settings.sponsors[]` on Sep 2 2026
 * (docs/SPONSOR_ATTRIBUTION_PLAN.md phase 2). `readSponsors(settings)` in
 * webinar.ts is the JSON reader this replaces; it stays for the migration
 * itself and for the reconcile script, and every application read comes here.
 *
 * The SHAPE is deliberately unchanged. Callers keep receiving `SponsorEntry`
 * exactly as the JSON reader produced it, sorted by `sortOrder`, so thirteen
 * call sites moved with a one-line change each rather than a rewrite. A table
 * migration whose blast radius is the whole app because the row shape also
 * changed is two migrations pretending to be one.
 *
 * Server-only: it imports `db`. The TYPE lives in webinar.ts, which is
 * client-safe, so the public session page can keep importing it.
 */
import { db } from "@/lib/db";
import type { SponsorEntry } from "@/lib/webinar";
import { readCustomSponsorTiers, sponsorTierList, type SponsorTierDef } from "@/lib/sponsor-tiers";

/** A row as stored. `tier` is a free string in the DB; narrowed on the way out. */
interface SponsorRow {
  id: string;
  name: string;
  tier: string | null;
  logoUrl: string | null;
  websiteUrl: string | null;
  description: string | null;
  sortOrder: number;
}

export const SPONSOR_SELECT = {
  id: true,
  name: true,
  tier: true,
  logoUrl: true,
  websiteUrl: true,
  description: true,
  sortOrder: true,
} as const;

/**
 * Row to `SponsorEntry`.
 *
 * `tier` is TEXT in the database rather than an enum, and since Oct 15, 2026
 * an organisation can define its own tiers, so any non-empty key passes
 * through (until then an unrecognised value was dropped, which would have
 * erased every custom tier on read). Display goes through the organisation's
 * tier list, where an unknown key shows as itself. Optional fields drop empty
 * strings, so a blank in the database and an absent key look identical to a
 * caller, which is what the JSON reader did.
 */
export function toSponsorEntry(row: SponsorRow): SponsorEntry {
  const tier = row.tier?.trim() || undefined;
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    ...(tier ? { tier } : {}),
    ...(row.logoUrl ? { logoUrl: row.logoUrl } : {}),
    ...(row.websiteUrl ? { websiteUrl: row.websiteUrl } : {}),
    ...(row.description ? { description: row.description } : {}),
  };
}

/** Every sponsor on an event, in display order. Empty array, never null. */
export async function getSponsors(eventId: string): Promise<SponsorEntry[]> {
  const rows = await db.sponsor.findMany({
    where: { eventId },
    select: SPONSOR_SELECT,
    // Ties broken by name so the order is stable across requests. The JSON
    // reader sorted on sortOrder alone and inherited array order for ties,
    // which is not a thing a table has.
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map(toSponsorEntry);
}

/**
 * Sponsor id to display name. For the export column and anywhere else that
 * holds ids and needs to print something a human recognises.
 */
export async function getSponsorNameMap(eventId: string): Promise<Map<string, string>> {
  const rows = await db.sponsor.findMany({
    where: { eventId },
    select: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Does this id name a sponsor on this event?
 *
 * The check every write path runs before persisting a `sponsorId`. It exists
 * as one function because it was previously an array scan repeated at four
 * call sites, and because after phase 2 the foreign key would raise a P2003
 * on a bad value: a constraint violation is the right last line of defence and
 * the wrong thing to show an organiser, who gets "that sponsor is not on this
 * event" instead.
 */
export async function sponsorExistsOnEvent(eventId: string, sponsorId: string): Promise<boolean> {
  const found = await db.sponsor.findFirst({
    where: { id: sponsorId, eventId },
    select: { id: true },
  });
  return found !== null;
}

/** The organisation's sponsor tiers: the built-ins, then its own. */
export async function getSponsorTiers(organizationId: string | null | undefined): Promise<SponsorTierDef[]> {
  if (!organizationId) return sponsorTierList([]);
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  return sponsorTierList(readCustomSponsorTiers(org?.settings));
}
