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

// Three presentation-type choices: "Oral/Poster" (a single combined option —
// oral and poster are not distinguished), Video, and Workshop. The combined
// option is stored as the ORAL enum value (no enum migration); the standalone
// POSTER value is kept in the enum + label map so any legacy abstracts still
// display correctly, but it's no longer offered in the picker.
export const PRESENTATION_TYPE_OPTIONS: { value: PresentationType; label: string }[] = [
  { value: "ORAL", label: "Oral/Poster Presentation" },
  { value: "VIDEO", label: "Video Presentation" },
  { value: "WORKSHOP", label: "Workshop Presentation" },
];

/** Short label, e.g. for badges. */
export const PRESENTATION_TYPE_LABELS: Record<PresentationType, string> = {
  ORAL: "Oral/Poster",
  POSTER: "Poster", // legacy standalone value — kept for old abstracts
  VIDEO: "Video",
  WORKSHOP: "Workshop",
};

/** Per-abstract reviewer assignment roles (AbstractReviewer.role). */
export const ABSTRACT_REVIEWER_ROLE_OPTIONS: { value: "PRIMARY" | "SECONDARY" | "CONSULTING"; label: string }[] = [
  { value: "PRIMARY", label: "Primary" },
  { value: "SECONDARY", label: "Secondary" },
  { value: "CONSULTING", label: "Consulting" },
];
