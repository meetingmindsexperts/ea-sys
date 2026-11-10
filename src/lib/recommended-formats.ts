/**
 * What a reviewer may recommend an abstract be presented as (Nov 10, 2026):
 * the presentation types this event offers (Content, Abstracts), plus Neither.
 * The list used to be fixed at Oral, Poster and Neither, so an oral-only event
 * still offered Poster and a Video or Workshop event offered neither of those.
 *
 * "Oral or Poster" is an author's either-way choice, not a format a reviewer
 * can recommend, so it stands for both Oral and Poster here.
 *
 * Client-safe: the review form builds its list from this and the review
 * service checks against it.
 */
import { readEnabledPresentationTypes } from "@/lib/abstract-presentation-types";

export const RECOMMENDED_FORMAT_VALUES = ["ORAL", "POSTER", "VIDEO", "WORKSHOP", "NEITHER"] as const;
export type RecommendedFormatValue = (typeof RECOMMENDED_FORMAT_VALUES)[number];

export const RECOMMENDED_FORMAT_LABELS: Record<RecommendedFormatValue, string> = {
  ORAL: "Oral presentation",
  POSTER: "Poster",
  VIDEO: "Video presentation",
  WORKSHOP: "Workshop",
  NEITHER: "Neither",
};

/** The formats a reviewer may pick on this event, in display order, Neither last. */
export function recommendableFormats(eventSettings: unknown): RecommendedFormatValue[] {
  const offered = new Set<string>();
  for (const type of readEnabledPresentationTypes(eventSettings)) {
    if (type === "ORAL_POSTER") {
      offered.add("ORAL");
      offered.add("POSTER");
    } else {
      offered.add(type);
    }
  }
  return RECOMMENDED_FORMAT_VALUES.filter((f) => f === "NEITHER" || offered.has(f));
}
