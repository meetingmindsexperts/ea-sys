/**
 * The token map (Nov 27, 2026; docs/EMAIL_TOKEN_MAP_PLAN.md): each token a
 * SAVED (custom) template or a typed email may use, once, with the audiences
 * a send sets it for and the words the editor lists it under. A leaf: no
 * server imports. Everything that used to be a hand-written list is derived
 * from it: the editor's accepted tokens and its Variables panel, the check
 * made when a send is scheduled, an abstract's own tokens.
 *
 * "Sets" means the send puts a value there, which may be empty by design (a
 * registrant has no {{presentationDetails}}); a token a send to that audience
 * does not set is refused by the unresolved-token guard. The email-sender-drift
 * tests send a saved template naming every token to every audience and fail
 * when this table and the senders disagree; `email-template-token-check.test.ts`
 * holds the editor's accepted list to it.
 *
 * A built-in template's own tokens are not here: they stay in its registry
 * entry (`variables`), pinned by the email-sender-drift tests.
 */
import type { BulkEmailAudience } from "@/lib/email-template-registry";
import { findUnresolvedTokens, normalizeTemplateTokens } from "@/lib/template-tokens";

/** The editor's Variables panel groups, in order. A token's group says what it is ABOUT; `audiences` says who a send sets it for. */
const TOKEN_GROUPS = [
  { id: "everyone", label: "Every email", hint: "Filled whoever you send to." },
  { id: "speakers", label: "Sent to speakers", hint: "Filled when the audience is speakers; empty for anyone else." },
  { id: "presenter", label: "Presenter agreement", hint: "Sent to speakers or abstract authors; empty for anyone who has already accepted it." },
  {
    id: "authors",
    label: "Sent to abstract authors",
    hint: "Filled when the audience is abstract submitters. Naming any of an abstract's own details sends one email per abstract, each with its own; drafts and withdrawn abstracts are left out.",
  },
  { id: "registrations", label: "Sent to registrations", hint: "Filled when the audience is registrations." },
  { id: "reviewers", label: "Sent to reviewers", hint: "Filled when the audience is reviewers. A send to anyone else is refused." },
  { id: "rsvp", label: "With an RSVP chosen", hint: "Filled only when an RSVP is picked in the send dialog." },
] as const;

type TokenGroupId = (typeof TOKEN_GROUPS)[number]["id"];

export interface EmailToken {
  /** The audiences a send sets it for. */
  audiences: "all" | readonly BulkEmailAudience[];
  /** Set only when an RSVP is picked for the send. */
  needsRsvp?: true;
  /** One abstract's own: set when the send goes once per abstract, which a saved template naming one does and a typed email never does. */
  perAbstract?: true;
  /** Where the editor lists it, with these words. A token with neither is accepted and not advertised (a plain-text mirror, the typed subject). */
  group?: TokenGroupId;
  description?: string;
}

const ALL = "all" as const;
const everyone = (description: string) => ({ audiences: ALL, group: "everyone", description }) as const;
/** About a speaker; set (empty) for every audience, as the bulk pipeline always has. */
const aboutSpeaker = (description: string) => ({ audiences: ALL, group: "speakers", description }) as const;
const speakersOnly = (description: string) => ({ audiences: ["speakers"], group: "speakers", description }) as const;
const presenter = (description: string) => ({ audiences: ["speakers", "abstracts"], group: "presenter", description }) as const;
const author = (description: string) => ({ audiences: ["abstracts"], group: "authors", description }) as const;
const abstractOwn = (description: string) => ({ audiences: ["abstracts"], perAbstract: true, group: "authors", description }) as const;
/** About a registration; set for every audience. */
const aboutRegistration = (description: string) => ({ audiences: ALL, group: "registrations", description }) as const;
const rsvp = (description: string) => ({ audiences: ALL, needsRsvp: true, group: "rsvp", description }) as const;
/** Accepted, not advertised. */
const UNLISTED = { audiences: ALL } as const;

export const EMAIL_TOKEN_MAP = {
  firstName: everyone("Recipient's first name"),
  lastName: everyone("Recipient's last name"),
  title: everyone("Title prefix (e.g. Dr.)"),
  eventName: everyone("Event name"),
  eventDate: everyone("Event start date, in the event's timezone"),
  eventDateRange: everyone("Event dates, collapsed on a single-day event"),
  eventVenue: everyone("Venue and city"),
  eventCity: everyone("Event city"),
  eventCountry: everyone("Event country"),
  eventAddress: everyone("Venue street address"),
  daysUntilEvent: everyone("Days until the event starts"),
  personalMessage: everyone("The message typed in the send dialog"),
  organizerName: everyone("Organizer name"),
  organizerEmail: everyone("Organizer email"),
  organizerSignature: everyone("Sender's personal email signature"),
  // The subject and note typed for this send; empty when none was typed.
  subject: UNLISTED,
  message: UNLISTED,

  speakerName: aboutSpeaker("Full name with title"),
  presentationDetails: aboutSpeaker("Their speaking sessions, with a heading"),
  presentationDetailsText: UNLISTED,
  moderatorDetails: aboutSpeaker("Sessions they moderate or chair, with the run-sheet"),
  moderatorDetailsText: UNLISTED,
  sessionDetails: aboutSpeaker("Their session titles, comma-separated"),
  agreementBlock: aboutSpeaker("The Review & Agree button (a signed speaker sees a note instead)"),
  agreementBlockText: UNLISTED,
  agreementLink: aboutSpeaker("The bare agreement URL"),
  agreementAttachment: aboutSpeaker("Invisible: attaches their personalised agreement file"),
  honorarium: speakersOnly("Agreed fee, e.g. USD 1,500.00 (0.00 when none)"),
  honorariumAmount: speakersOnly("The fee amount alone"),
  honorariumCurrency: speakersOnly("The fee currency alone"),

  presenterAgreementAttachment: presenter("Invisible: attaches their personalised presenter agreement PDF"),
  presenterAgreementLink: presenter("Their link to review and accept the presenter agreement"),

  authorName: author("The author's full name with title"),
  managementLink: author("Their link to sign in and see their abstracts"),
  abstractNumber: abstractOwn("The abstract's number, e.g. A-007 (one email per abstract)"),
  abstractTitle: abstractOwn("The abstract's title (one email per abstract)"),
  presentationType: abstractOwn("Its presentation type, e.g. Oral (one email per abstract)"),
  theme: abstractOwn("Its theme (one email per abstract)"),
  coAuthorNames: abstractOwn("Its co-authors, or None (one email per abstract)"),
  newStatus: abstractOwn("Its status as it stands, e.g. ACCEPTED or NOT ACCEPTED (one email per abstract)"),
  statusHeading: abstractOwn("A heading for that status (one email per abstract)"),
  statusMessage: abstractOwn("A sentence for that status (one email per abstract)"),
  reviewNotes: abstractOwn("The reviewers' notes to the author, in a box; empty when none (one email per abstract)"),
  reviewScore: abstractOwn("The mean review score; empty when none (one email per abstract)"),
  // Empty in a saved template (the offer rides only on the built-in
  // confirmation), but set: a copy of that confirmation carries the token.
  travelGrantBlock: { audiences: ["abstracts"] },
  travelGrantBlockText: { audiences: ["abstracts"] },

  ticketType: aboutRegistration("Registration type"),
  registrationId: aboutRegistration("Registration number"),
  entryBarcode: aboutRegistration("Entry barcode image (in-person registrations)"),
  entryBarcodeText: UNLISTED,
  amount: {
    audiences: ["registrations"],
    group: "registrations",
    description: "Balance due, e.g. USD 100.00; empty for a group member or anyone who owes nothing (a send to another audience is refused)",
  },
  // The Pay Now button for someone who owes; set, empty, for every audience.
  paymentBlock: UNLISTED,

  reviewLink: { audiences: ["reviewers"], group: "reviewers", description: "Their link to sign in and open My Reviews" },

  rsvpLink: rsvp("Their personal RSVP link"),
  rsvpName: rsvp("The RSVP's name"),
  rsvpButton: rsvp("An RSVP button"),
} as const satisfies Record<string, EmailToken>;

export type EmailTokenKey = keyof typeof EMAIL_TOKEN_MAP;

/**
 * The tokens a send to this audience sets (RSVP tokens only with `withRsvp`).
 * `typed`: inside the subject and message typed for an email with no saved
 * template. The same set, less an abstract's own tokens (a typed email goes
 * once per author) and less {{subject}}, {{message}} and {{personalMessage}},
 * which are the typed text itself.
 */
export function tokensSetFor(audience: BulkEmailAudience, opts: { withRsvp?: boolean; typed?: boolean } = {}): EmailTokenKey[] {
  return (Object.keys(EMAIL_TOKEN_MAP) as EmailTokenKey[]).filter((key) => {
    const token: EmailToken = EMAIL_TOKEN_MAP[key];
    if (token.needsRsvp && !opts.withRsvp) return false;
    if (opts.typed && (token.perAbstract || key === "subject" || key === "message" || key === "personalMessage")) return false;
    return token.audiences === "all" || token.audiences.includes(audience);
  });
}

const AUDIENCE_NOUN: Record<BulkEmailAudience, string> = {
  registrations: "registrations",
  speakers: "speakers",
  reviewers: "reviewers",
  abstracts: "abstract authors",
};

/** Why one token is not set for this send, in words for the sender. */
function whyNotSet(t: string, audience: BulkEmailAudience, typed: boolean): string {
  const token: EmailToken | undefined = (EMAIL_TOKEN_MAP as Record<string, EmailToken>)[t];
  if (!token) return `{{${t}}} is not a token this email can use (check its spelling)`;
  if (token.audiences === "all") return `{{${t}}} cannot be used inside the typed subject or message`;
  if (typed && token.perAbstract && audience === "abstracts") {
    return `{{${t}}} is one abstract's own detail, and a typed email goes once per author (put the text in a saved template to send one email per abstract)`;
  }
  return `{{${t}}} is filled only when sending to ${token.audiences.map((a) => AUDIENCE_NOUN[a]).join(" or ")}`;
}

/**
 * What an email to `audience` names that the send will not set, so every email
 * would be refused: a sentence for the sender, or null. Asked when the send is
 * scheduled (precheckBulkEmailViability), not found out when it fires.
 * "saved-template": pass the template's subject and HTML (what the send's own
 * guard refuses on). "typed": pass the typed subject and message. The RSVP
 * tokens count as set: the RSVP check beside it owns them.
 */
export function emailTokenRefusal(
  audience: BulkEmailAudience,
  kind: "saved-template" | "typed",
  ...texts: Array<string | null | undefined>
): { message: string; tokens: string[] } | null {
  const typed = kind === "typed";
  const set = new Set<string>(tokensSetFor(audience, { withRsvp: true, typed }));
  const tokens = findUnresolvedTokens(...texts.map((t) => normalizeTemplateTokens(t ?? ""))).filter((t) => !set.has(t));
  if (tokens.length === 0) return null;
  const why = tokens.map((t) => whyNotSet(t, audience, typed)).join("; ");
  return {
    tokens,
    message: typed
      ? `This email cannot go to ${AUDIENCE_NOUN[audience]} as it is: ${why}. Change the subject or the message, then try again.`
      : `This template cannot go to ${AUDIENCE_NOUN[audience]} as it is: ${why}. Change it under Communications, Email Templates, then try again.`,
  };
}

/** What a saved template's editor lists, grouped by what a token is about (the map's own groups and words). */
export const CUSTOM_TEMPLATE_VARIABLE_GROUPS: ReadonlyArray<{ label: string; hint: string; variables: ReadonlyArray<{ key: string; description: string }> }> =
  TOKEN_GROUPS.map((g) => ({
    label: g.label,
    hint: g.hint,
    variables: (Object.entries(EMAIL_TOKEN_MAP) as Array<[string, EmailToken]>)
      .filter(([, t]) => t.group === g.id && t.description)
      .map(([key, t]) => ({ key, description: t.description! })),
  }));

/** One abstract's own tokens: an email that names one is sent once per abstract. */
export const ABSTRACT_OWN_TOKEN_KEYS: readonly string[] = (Object.entries(EMAIL_TOKEN_MAP) as Array<[string, EmailToken]>)
  .filter(([, t]) => t.perAbstract)
  .map(([key]) => key);

/**
 * The map's tokens a BUILT-IN template sent from Communications may also use,
 * beyond its own: what every bulk send sets for everyone (not the typed
 * subject and message, which only a typed email and a saved template get),
 * and a speaker's.
 */
export const BUILT_IN_BULK_TOKEN_KEYS: readonly string[] = (Object.entries(EMAIL_TOKEN_MAP) as Array<[string, EmailToken]>)
  .filter(([key, t]) => (t.audiences === "all" ? key !== "subject" && key !== "message" : t.audiences.includes("speakers")))
  .map(([key]) => key);
