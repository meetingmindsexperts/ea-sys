/**
 * What a reviewer may recommend an abstract be presented as (Nov 10, 2026):
 * the presentation types this event offers, plus Neither. Since Nov 24, 2026
 * the types and their names are the organisation's
 * (`abstract-presentation-types.ts`), and since step 4 of
 * docs/ABSTRACT_PRESENTATION_TYPES_PLAN.md an organisation's own type can be
 * recommended like a built-in.
 *
 * The either-way type (key `ORAL_POSTER`, "Oral or Poster" unless renamed) is
 * an author's choice, not a format a reviewer can recommend, so it stands for
 * Oral and Poster here, even where those two are not ticked on their own
 * (unless the organisation retired them). It is never itself a recommendation.
 *
 * A recommendation already made keeps its value whatever happens to the type
 * later: the review service accepts the stored value on a re-save.
 *
 * Client-safe: the review form builds its list from this and the review
 * service checks against it.
 */
import { z } from "zod";
import {
  EITHER_WAY_STANDS_FOR,
  EITHER_WAY_TYPE_KEY,
  offeredPresentationTypes,
  presentationTypeKeySchema,
  presentationTypeLabel,
  type PresentationTypeDef,
} from "@/lib/abstract-presentation-types";

export const NEITHER_FORMAT = "NEITHER" as const;
export const NEITHER_FORMAT_LABEL = "Neither";

/**
 * What a door's schema accepts for a recommendation: a key's shape (NEITHER
 * has one). Whether THIS event allows it is `recommendableFormats`, asked by
 * the review service, so an organisation's own type needs no schema change.
 */
export const recommendedFormatSchema = presentationTypeKeySchema;
export type RecommendedFormatValue = z.infer<typeof recommendedFormatSchema>;

/** The formats a reviewer may pick on this event, in the list's order, Neither last. */
export function recommendableFormats(eventSettings: unknown, types: readonly PresentationTypeDef[]): string[] {
  const live = new Set(types.filter((t) => !t.retired).map((t) => t.key));
  const offered = new Set<string>();
  for (const type of offeredPresentationTypes(eventSettings, types)) {
    if (type.key === EITHER_WAY_TYPE_KEY) EITHER_WAY_STANDS_FOR.filter((k) => live.has(k)).forEach((k) => offered.add(k));
    else offered.add(type.key);
  }
  const inOrder = types.map((t) => t.key).filter((k) => offered.has(k));
  return [...inOrder, NEITHER_FORMAT];
}

/**
 * A recommendation as an assistant writes it (step 5): a key, a type's name or
 * Neither, in any case and spacing ("case report", "Case Report", "CASE_REPORT").
 * Only the written form is read here; whether the event allows it stays the
 * review service's rule. What matches nothing is passed on as written, so the
 * service refuses it with the event's choices.
 */
export function resolveWrittenRecommendation(written: string, types: readonly PresentationTypeDef[]): string {
  const text = written.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const asKey = text.toUpperCase().replace(/[\s-]+/g, "_");
  if (asKey === NEITHER_FORMAT) return NEITHER_FORMAT;
  const byKey = types.find((t) => t.key === asKey);
  if (byKey) return byKey.key;
  return types.find((t) => t.label.toLowerCase() === lower)?.key ?? text;
}

/** A recommendation's name: the type's, or Neither. A value the list does not know shows as itself. */
export function recommendedFormatLabel(types: readonly PresentationTypeDef[], value: string | null | undefined): string {
  if (!value) return "";
  if (value === NEITHER_FORMAT) return NEITHER_FORMAT_LABEL;
  return presentationTypeLabel(types, value);
}
