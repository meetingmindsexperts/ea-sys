import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { loadRegistrantScope } from "@/lib/registrant-access";
import { readAccountDetails } from "@/lib/registrant-details";
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
 * Sources, first one with a value wins, per empty field:
 *  1. the account's details, exactly as /my-account/details shows them
 *     (readAccountDetails: the saved profile, else the latest registration);
 *  2. the person's own speaker records on other events, newest first. This is
 *     where a bio comes from: an account has none.
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

type Details = Partial<Record<SuggestedField, string | null>>;
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

const SPEAKER_SELECT = Object.fromEntries(SUGGESTED_FIELDS.map((f) => [f, true])) as Record<SuggestedField, true>;

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
    const [scope, otherSpeakers] = await Promise.all([
      loadRegistrantScope(args.userId, { sessionTokenVersion: args.sessionTokenVersion }),
      db.speaker.findMany({
        where: { userId: args.userId, eventId: { not: args.eventId } },
        orderBy: { updatedAt: "desc" },
        take: 3,
        select: SPEAKER_SELECT,
      }),
    ]);
    const account = scope ? (await readAccountDetails(scope)).details : null;
    return pickSuggestions(args.current, [...(account ? [account] : []), ...otherSpeakers]);
  } catch (err) {
    apiLogger.warn({ err, msg: "submitter-profile:suggestions-failed", userId: args.userId, eventId: args.eventId });
    return {};
  }
}
