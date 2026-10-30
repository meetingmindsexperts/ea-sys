/**
 * Which sponsor is on which stand (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md,
 * section 10). One rule for the 2D plan, the PDF and the AI attendees; the
 * walkable venue's world.js keeps the same rule in `standSponsor`.
 *
 * - A stand placed on the plan carries its own sponsor: `sponsorId`, null for
 *   Available. A sponsor deleted since reads as Available.
 * - An automatic stand (the exhibition room's generated grid) takes the nth
 *   sponsor in tier order, as it always has.
 *
 * Client-safe: pure, no Node imports.
 */
import type { LayoutItem, VenueLayout } from "./layout";

export type StandItem = Extract<LayoutItem, { t: "stand" }>;

/** The least the rule needs of a sponsor, in the venue's stand order (programme.ts `orderSponsors`). */
export interface StandSponsorRef {
  id: string;
  name: string;
  tier?: string;
}

export const layoutStands = (layout: VenueLayout): StandItem[] => layout.items.filter((it): it is StandItem => it.t === "stand");

/** The number printed on a stand: its own on a placed stand, its place in the order on an automatic one. */
export const standNumber = (s: StandItem): string => s.number ?? String(s.n);

/** The sponsor on a stand, or null when it is Available. */
export function standSponsor<T extends StandSponsorRef>(s: StandItem, ordered: T[]): T | null {
  if (s.key !== undefined) return s.sponsorId ? (ordered.find((o) => o.id === s.sponsorId) ?? null) : null;
  return ordered[s.n - 1] ?? null;
}

/** The sponsors that have a stand, each once, in the venue's order (one sponsor may hold several stands, decision G5). */
export function sponsorsWithStands<T extends StandSponsorRef>(stands: StandItem[], ordered: T[]): T[] {
  const held = new Set(stands.map((s) => standSponsor(s, ordered)?.id).filter(Boolean));
  return ordered.filter((o) => held.has(o.id));
}
