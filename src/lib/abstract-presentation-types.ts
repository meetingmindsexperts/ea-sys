/**
 * Per-event presentation-type offering (July 13, 2026, organizer request).
 *
 * Organizers choose WHICH presentation types their event's abstract form
 * offers (e.g. a video-free conference hides "Video Presentation"). The
 * choice lives in `Event.settings.abstractPresentationTypes` (JSON string
 * array — no migration); absent/empty/invalid ⇒ ALL types are offered, so
 * existing events behave exactly as before (owner decision).
 *
 * Client-safe (Prisma enum value import only — same pattern as
 * registration-enums.ts). Read paths: the submit/edit forms filter their
 * dropdowns through this; the abstract create/update routes ENFORCE it
 * server-side (a form can be bypassed), except that an existing abstract may
 * always KEEP its current type after the organizer narrows the offering.
 */
import { PresentationType } from "@prisma/client";

/** All offerable types, in display order (mirrors PRESENTATION_TYPE_OPTIONS). */
export const ALL_PRESENTATION_TYPE_VALUES: PresentationType[] = [
  "ORAL_POSTER",
  "ORAL",
  "POSTER",
  "VIDEO",
  "WORKSHOP",
];

const VALID = new Set<string>(ALL_PRESENTATION_TYPE_VALUES);

/**
 * The event's offered presentation types, from its `settings` JSON.
 * Defensive: unknown values are dropped; an absent / empty / fully-invalid
 * config falls back to ALL types (never an empty offering — that would make
 * submission impossible since the type is mandatory to submit).
 */
export function readEnabledPresentationTypes(settings: unknown): PresentationType[] {
  const raw = (settings as { abstractPresentationTypes?: unknown } | null | undefined)
    ?.abstractPresentationTypes;
  if (!Array.isArray(raw)) return ALL_PRESENTATION_TYPE_VALUES;
  const cleaned = raw
    .filter((v): v is string => typeof v === "string")
    .filter((v) => VALID.has(v)) as PresentationType[];
  // Preserve canonical display order regardless of stored order.
  const set = new Set(cleaned);
  const ordered = ALL_PRESENTATION_TYPE_VALUES.filter((v) => set.has(v));
  return ordered.length > 0 ? ordered : ALL_PRESENTATION_TYPE_VALUES;
}

/** True when `type` may be newly chosen on this event. */
export function isPresentationTypeEnabled(settings: unknown, type: string): boolean {
  return (readEnabledPresentationTypes(settings) as string[]).includes(type);
}
