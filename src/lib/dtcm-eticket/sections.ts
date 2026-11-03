/**
 * Which DET section and price type each registration type buys
 * (docs/DTCM_ETICKET_PLAN.md §4.2, step 2). Stored in `Event.settings.dtcm`,
 * written only by `/api/events/[eventId]/dtcm-eticket` (a route-owned key, so
 * the event edit can neither write nor clobber it) and never copied by clone
 * (not on the clone allow-list: a clone starts with DTCM off).
 *
 * A mapping is checked against DET's live performance map before it is saved:
 * the section must exist, and the price type must belong to that section's
 * price category, which is the pairing DET enforces on a basket. The
 * environment it was checked against is stored with it, because a mapping
 * checked in the sandbox names sandbox sections.
 *
 * Client-safe: no imports beyond types.
 */
import type { DetEnvironment, DetPerformanceSummary } from "./types";

export const DTCM_EVENT_SETTINGS_KEY = "dtcm";

export interface DtcmSectionMapping {
  area: string;
  priceTypeCode: string;
}

export interface StoredDtcmEventSettings {
  /** Keyed by TicketType id. A deleted type's entry is ignored on read. */
  sections?: Record<string, DtcmSectionMapping>;
  /** The DET environment the mapping was last checked against. */
  environment?: DetEnvironment;
  /** The performance code it was checked against. */
  performanceCode?: string;
  checkedAt?: string;
}

/** The stored block, or an empty one; never throws on a malformed blob. */
export function readDtcmEventSettings(eventSettings: unknown): StoredDtcmEventSettings {
  if (!eventSettings || typeof eventSettings !== "object") return {};
  const raw = (eventSettings as Record<string, unknown>)[DTCM_EVENT_SETTINGS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const stored = raw as StoredDtcmEventSettings;
  const sections: Record<string, DtcmSectionMapping> = {};
  for (const [ticketTypeId, m] of Object.entries(stored.sections ?? {})) {
    if (m && typeof m.area === "string" && typeof m.priceTypeCode === "string") sections[ticketTypeId] = m;
  }
  return { ...stored, sections };
}

/**
 * Whether a stored mapping describes what a purchase would use NOW: checked
 * against the same DET environment and the same performance code. Anything
 * that buys (the desk, the bulk run) refuses a mapping for which this is
 * false; the card offers to check it again. Section codes like SVIP2 exist in
 * both environments, so a sandbox-checked mapping must never silently drive a
 * production purchase.
 */
export function isMappingCurrent(
  stored: StoredDtcmEventSettings,
  activeEnvironment: DetEnvironment,
  performanceCode: string | null,
): boolean {
  return Boolean(stored.checkedAt) && stored.environment === activeEnvironment && stored.performanceCode === performanceCode;
}

/** For each section, the price types DET will sell in it (same price category), with their prices. */
export function sectionOptions(performance: DetPerformanceSummary) {
  return performance.sections.map((section) => ({
    ...section,
    priceTypes: performance.priceTypes.filter((p) => p.categoryId === section.categoryId),
  }));
}

/** Why DET would refuse this mapping, or null when it would accept it. */
export function mappingProblem(mapping: DtcmSectionMapping, performance: DetPerformanceSummary): string | null {
  const section = performance.sections.find((s) => s.code === mapping.area);
  if (!section) return `Section ${mapping.area} is not on performance ${performance.performanceCode}`;
  const priceType = performance.priceTypes.find((p) => p.code === mapping.priceTypeCode && p.categoryId === section.categoryId);
  if (!priceType) return `Price type ${mapping.priceTypeCode} is not sold in section ${mapping.area}`;
  return null;
}

/**
 * Seats a section can still sell, as far as EA-SYS can tell: capacity less
 * holds. DET does not expose per-section sales (its availability call only
 * reports per price category, and called a sold-out section "Ok" in UAT), so
 * this is an upper bound; DET's `5005 Section soldout` is the real answer.
 */
export function sectionHeadroom(section: { capacity: number | null; holds: number | null }): number | null {
  if (section.capacity === null) return null;
  return Math.max(section.capacity - (section.holds ?? 0), 0);
}
