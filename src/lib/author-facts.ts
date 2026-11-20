/**
 * What a registration's person is in the scientific programme, READ and never
 * stored (owner, Nov 20, 2026; docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md §4):
 * their abstracts' outcome, and whether they are a speaker on the programme.
 *
 * "Presenter" is not a registration type and not a saved flag: it is "has an
 * accepted abstract", asked at the moment of asking, so it cannot go stale
 * when an abstract is withdrawn or a decision is reversed.
 *
 * ONE answer for the Registrations list, its filters, its export and the
 * Presenter mark. The person is the speaker record LINKED to the registration
 * (`Speaker.sourceRegistrationId`), the same link every sign-up and grant
 * writes; a registration with no linked speaker has no facts.
 *
 * The pure half (`abstractOutcomeOf`, the labels, the filter matchers) is
 * client-safe; `loadAuthorFacts` is the server's reader.
 */

/** A person's abstracts, summed up as the organiser thinks of them. */
export type AbstractOutcome =
  /** At least one accepted: a presenter. */
  | "accepted"
  /** None accepted, at least one submitted and awaiting a decision. */
  | "awaiting"
  /** Every submitted abstract was rejected. */
  | "rejected"
  /** Signed up to submit, or holds only drafts or withdrawn abstracts. */
  | "none-submitted";

/** Where a speaker stands: on a session or topic of the programme, or a speaker record only. */
export type SpeakerPlace = "programme" | "record";

export interface AuthorFacts {
  abstractOutcome: AbstractOutcome | null;
  speakerPlace: SpeakerPlace | null;
}

/** The filter values the list and the export accept; "none" is "has no abstract" / "not a speaker". */
export const ABSTRACT_FILTER_VALUES = ["accepted", "awaiting", "rejected", "none-submitted", "none"] as const;
export const SPEAKER_FILTER_VALUES = ["programme", "record", "none"] as const;
export type AbstractFilter = (typeof ABSTRACT_FILTER_VALUES)[number];
export type SpeakerFilter = (typeof SPEAKER_FILTER_VALUES)[number];

export const ABSTRACT_FILTER_LABELS: Record<AbstractFilter, string> = {
  accepted: "Abstract accepted (presenters)",
  awaiting: "Abstract awaiting a decision",
  rejected: "Abstract rejected",
  "none-submitted": "Signed up, nothing submitted",
  none: "No abstract",
};

export const SPEAKER_FILTER_LABELS: Record<SpeakerFilter, string> = {
  programme: "Speaker on the programme",
  record: "Speaker, not on the programme",
  none: "Not a speaker",
};

const AWAITING_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "REVISION_REQUESTED"];

/**
 * One person's outcome from their abstracts' statuses. Accepted beats
 * awaiting beats rejected: one accepted abstract makes a presenter whatever
 * became of the others. `signedUp` is "their registration was made by the
 * abstract sign-up", which counts even before a first draft exists.
 */
export function abstractOutcomeOf(statuses: readonly string[], signedUp: boolean): AbstractOutcome | null {
  if (statuses.includes("ACCEPTED")) return "accepted";
  if (statuses.some((s) => AWAITING_STATUSES.includes(s))) return "awaiting";
  if (statuses.includes("REJECTED")) return "rejected";
  if (statuses.length > 0 || signedUp) return "none-submitted";
  return null;
}

export function isAbstractFilter(value: string): value is AbstractFilter {
  return (ABSTRACT_FILTER_VALUES as readonly string[]).includes(value);
}

export function isSpeakerFilter(value: string): value is SpeakerFilter {
  return (SPEAKER_FILTER_VALUES as readonly string[]).includes(value);
}

/** Does a row with this outcome pass the Abstract filter? No filter passes everything. */
export function matchesAbstractFilter(outcome: AbstractOutcome | null | undefined, filter: AbstractFilter | null | undefined): boolean {
  if (!filter) return true;
  return filter === "none" ? !outcome : outcome === filter;
}

/** Does a row with this place pass the Speaker filter? No filter passes everything. */
export function matchesSpeakerFilter(place: SpeakerPlace | null | undefined, filter: SpeakerFilter | null | undefined): boolean {
  if (!filter) return true;
  return filter === "none" ? !place : place === filter;
}
