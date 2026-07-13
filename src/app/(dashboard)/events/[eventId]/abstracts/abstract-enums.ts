/**
 * Shared abstract status + presentation-type display constants.
 *
 * Single source of truth for the abstracts list page, the edit page, and
 * the review/edit dialogs — they previously hardcoded their own status
 * colour maps (which had drifted: yellow vs amber) and presentation-type
 * dropdowns (which had drifted: submitter dialog offered only ORAL/POSTER
 * while the full pages offered all four). Importing the Prisma enums keeps
 * these `Record`s exhaustive — TypeScript fails the build if a new enum
 * value lacks a label/colour (same pattern as registration-enums.ts).
 */

import { AbstractStatus, PresentationType } from "@prisma/client";
import { readEnabledPresentationTypes } from "@/lib/abstract-presentation-types";

export const ABSTRACT_STATUS_COLORS: Record<AbstractStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-700",
  SUBMITTED: "bg-blue-100 text-blue-700",
  UNDER_REVIEW: "bg-amber-100 text-amber-700",
  ACCEPTED: "bg-green-100 text-green-700",
  REJECTED: "bg-red-100 text-red-700",
  REVISION_REQUESTED: "bg-orange-100 text-orange-700",
  WITHDRAWN: "bg-gray-100 text-gray-500",
};

/** Tailwind colour classes for a status string (with a safe fallback). */
export function abstractStatusColor(status: string): string {
  return ABSTRACT_STATUS_COLORS[status as AbstractStatus] ?? "bg-gray-100 text-gray-700";
}

/** "UNDER_REVIEW" → "UNDER REVIEW" (matches the prior render behavior). */
export function abstractStatusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

// Presentation-type choices: a combined "Oral or Poster" plus the separate
// Oral and Poster, then Video and Workshop.
export const PRESENTATION_TYPE_OPTIONS: { value: PresentationType; label: string }[] = [
  { value: "ORAL_POSTER", label: "Oral or Poster Presentation" },
  { value: "ORAL", label: "Oral Presentation" },
  { value: "POSTER", label: "Poster Presentation" },
  { value: "VIDEO", label: "Video Presentation" },
  { value: "WORKSHOP", label: "Workshop Presentation" },
];

/**
 * The presentation-type options an event actually OFFERS (July 13, 2026):
 * organizers narrow the list per event via Content → Abstracts
 * (`Event.settings.abstractPresentationTypes`); absent config = all types.
 * `currentValue` (edit forms): an abstract's existing type stays selectable
 * even after the organizer disabled it — narrowing the offering must not
 * force an unrelated edit to change the type — annotated "(no longer offered)".
 */
export function enabledPresentationTypeOptions(
  settings: unknown,
  currentValue?: string | null,
): { value: PresentationType; label: string }[] {
  const enabled = new Set<string>(readEnabledPresentationTypes(settings));
  const options = PRESENTATION_TYPE_OPTIONS.filter((o) => enabled.has(o.value));
  if (currentValue && !enabled.has(currentValue)) {
    const current = PRESENTATION_TYPE_OPTIONS.find((o) => o.value === currentValue);
    if (current) options.push({ ...current, label: `${current.label} (no longer offered)` });
  }
  return options;
}

/** Short label, e.g. for badges. */
export const PRESENTATION_TYPE_LABELS: Record<PresentationType, string> = {
  ORAL: "Oral",
  POSTER: "Poster",
  ORAL_POSTER: "Oral or Poster",
  VIDEO: "Video",
  WORKSHOP: "Workshop",
};

/** Per-abstract reviewer assignment roles (AbstractReviewer.role). */
export const ABSTRACT_REVIEWER_ROLE_OPTIONS: { value: "PRIMARY" | "SECONDARY" | "CONSULTING"; label: string }[] = [
  { value: "PRIMARY", label: "Primary" },
  { value: "SECONDARY", label: "Secondary" },
  { value: "CONSULTING", label: "Consulting" },
];
