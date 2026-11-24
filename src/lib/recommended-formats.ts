/**
 * What a reviewer may recommend an abstract be presented as (Nov 10, 2026):
 * the presentation types this event offers, plus Neither. Since Nov 24, 2026
 * the types and their names are the organisation's
 * (`abstract-presentation-types.ts`).
 *
 * The either-way type (key `ORAL_POSTER`, "Oral or Poster" unless renamed) is
 * an author's choice, not a format a reviewer can recommend, so it stands for
 * Oral and Poster here, even where those two are not offered on their own.
 *
 * Until step 2 of the plan the stored value is the Postgres enum
 * `RecommendedFormat`, so only the built-in keys and Neither can be stored:
 * `RECOMMENDED_FORMAT_VALUES` is what a door's schema accepts.
 *
 * Client-safe: the review form builds its list from this and the review
 * service checks against it.
 */
import {
  EITHER_WAY_STANDS_FOR,
  EITHER_WAY_TYPE_KEY,
  offeredPresentationTypes,
  presentationTypeLabel,
  RECOMMENDABLE_BUILT_IN_KEYS,
  type PresentationTypeDef,
} from "@/lib/abstract-presentation-types";

export const NEITHER_FORMAT = "NEITHER" as const;
export const NEITHER_FORMAT_LABEL = "Neither";

/** What may be stored today: every built-in a reviewer can recommend, and Neither. */
export const RECOMMENDED_FORMAT_VALUES = [...RECOMMENDABLE_BUILT_IN_KEYS, NEITHER_FORMAT] as const;
export type RecommendedFormatValue = (typeof RECOMMENDED_FORMAT_VALUES)[number];

/**
 * The formats a reviewer may pick on this event, in the list's order, Neither
 * last. Until step 4 of the plan only what the enum column can store is
 * offered: an organisation's own type, once it can be ticked (step 3), would
 * otherwise be offered and then refused by every door (review of 89d803698).
 */
export function recommendableFormats(eventSettings: unknown, types: readonly PresentationTypeDef[]): string[] {
  const offered = new Set<string>();
  for (const type of offeredPresentationTypes(eventSettings, types)) {
    if (type.key === EITHER_WAY_TYPE_KEY) EITHER_WAY_STANDS_FOR.forEach((k) => offered.add(k));
    else offered.add(type.key);
  }
  const storable = new Set<string>(RECOMMENDED_FORMAT_VALUES);
  const inOrder = types.map((t) => t.key).filter((k) => offered.has(k) && storable.has(k));
  return [...inOrder, NEITHER_FORMAT];
}

/** A recommendation's name: the type's, or Neither. A value the list does not know shows as itself. */
export function recommendedFormatLabel(types: readonly PresentationTypeDef[], value: string | null | undefined): string {
  if (!value) return "";
  if (value === NEITHER_FORMAT) return NEITHER_FORMAT_LABEL;
  return presentationTypeLabel(types, value);
}
