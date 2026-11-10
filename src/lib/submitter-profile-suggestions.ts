import { apiLogger } from "@/lib/logger";
import { loadOwnDetailSources, type OwnDetails } from "@/lib/own-details-sources";
import { loadRegistrantScope } from "@/lib/registrant-access";
import { isProfileIncomplete, type ProfileCompletenessInput } from "@/lib/submitter-profile-completeness";

/**
 * What the event's My Details form is opened with when the person's speaker
 * record on this event is incomplete (owner, Nov 10, 2026).
 *
 * A speaker record made by signing in to a new event holds a name and an
 * address only, while the same person's account page shows every detail. The
 * form then asked them to type it all again, once per event. The details the
 * person already gave are offered here and the FORM is filled with them;
 * nothing is written until they press Save, so an account edit still never
 * reaches a speaker record on its own (registrant-details.ts).
 *
 * Where the values come from is loadOwnDetailSources (own-details-sources.ts),
 * the one rule the abstract sign-in door reads too: the account's saved
 * details, the person's speaker records on other events (where a bio lives),
 * their latest registrations.
 */

export const SUGGESTED_FIELDS = [
  "title",
  "role",
  "specialty",
  "customSpecialty",
  "organization",
  "jobTitle",
  "phone",
  "city",
  "state",
  "zipCode",
  "country",
  "bio",
] as const;
export type SuggestedField = (typeof SUGGESTED_FIELDS)[number];

type Details = Pick<OwnDetails, SuggestedField>;
export type SpeakerDetailSuggestions = Partial<Record<SuggestedField, string>>;

const filled = (v: string | null | undefined): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * The empty fields of `current`, each with the first source's value. A written
 * in specialty travels only with the "Others" it belongs to: the speaker's own
 * specialty, or the one suggested from the same source.
 */
export function pickSuggestions(current: Details, sources: Details[]): SpeakerDetailSuggestions {
  const out: SpeakerDetailSuggestions = {};
  for (const field of SUGGESTED_FIELDS) {
    if (field === "customSpecialty" || filled(current[field])) continue;
    const source = sources.find((s) => filled(s[field]));
    if (!source) continue;
    out[field] = (source[field] as string).trim();
    if (field === "specialty" && out.specialty === "Others" && filled(source.customSpecialty)) {
      out.customSpecialty = source.customSpecialty.trim();
    }
  }
  return out;
}

/**
 * Never throws: a failed lookup means an empty form, as before, not a page
 * that will not load.
 */
export async function suggestSpeakerDetails(args: {
  userId: string;
  eventId: string;
  sessionTokenVersion: number | undefined;
  current: Details & ProfileCompletenessInput;
}): Promise<SpeakerDetailSuggestions> {
  if (!isProfileIncomplete(args.current)) return {};
  try {
    const scope = await loadRegistrantScope(args.userId, { sessionTokenVersion: args.sessionTokenVersion });
    const sources = await loadOwnDetailSources({ userId: args.userId, scope, exceptEventId: args.eventId });
    return pickSuggestions(args.current, sources);
  } catch (err) {
    apiLogger.warn({ err, msg: "submitter-profile:suggestions-failed", userId: args.userId, eventId: args.eventId });
    return {};
  }
}
