/**
 * The token map (Nov 27, 2026; docs/EMAIL_TOKEN_MAP_PLAN.md): each token a
 * SAVED (custom) template may use, once, with the audiences a send sets it
 * for. A leaf: no server imports.
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

export interface EmailToken {
  /** The audiences a send sets it for. */
  audiences: "all" | readonly BulkEmailAudience[];
  /** Set only when an RSVP is picked for the send. */
  needsRsvp?: true;
  /** One abstract's own: set when the send goes once per abstract, which a saved template naming one does and a typed email never does. */
  perAbstract?: true;
}

const ALL = { audiences: "all" } as const;
const SPEAKERS = { audiences: ["speakers"] } as const;
const PRESENTERS = { audiences: ["speakers", "abstracts"] } as const;
const AUTHORS = { audiences: ["abstracts"] } as const;
const ABSTRACT_OWN = { audiences: ["abstracts"], perAbstract: true } as const;
const RSVP = { audiences: "all", needsRsvp: true } as const;

export const EMAIL_TOKEN_MAP = {
  // The event, and the person.
  eventName: ALL, eventDate: ALL, eventDateRange: ALL, eventVenue: ALL,
  eventCity: ALL, eventCountry: ALL, eventAddress: ALL, daysUntilEvent: ALL,
  title: ALL, firstName: ALL, lastName: ALL, speakerName: ALL,
  organizerName: ALL, organizerEmail: ALL, organizerSignature: ALL, personalMessage: ALL,
  // The subject and note typed for this send; empty when none was typed.
  subject: ALL, message: ALL,
  ticketType: ALL, registrationId: ALL,
  // Set for everyone, empty for an audience they mean nothing to.
  presentationDetails: ALL, presentationDetailsText: ALL,
  moderatorDetails: ALL, moderatorDetailsText: ALL, sessionDetails: ALL,
  agreementLink: ALL, agreementBlock: ALL, agreementBlockText: ALL, agreementAttachment: ALL,
  entryBarcode: ALL, entryBarcodeText: ALL, paymentBlock: ALL,
  rsvpLink: RSVP, rsvpName: RSVP, rsvpButton: RSVP,
  // One audience's own.
  amount: { audiences: ["registrations"] },
  reviewLink: { audiences: ["reviewers"] },
  honorarium: SPEAKERS, honorariumAmount: SPEAKERS, honorariumCurrency: SPEAKERS,
  presenterAgreementAttachment: PRESENTERS, presenterAgreementLink: PRESENTERS,
  authorName: AUTHORS, managementLink: AUTHORS,
  abstractNumber: ABSTRACT_OWN, abstractTitle: ABSTRACT_OWN, presentationType: ABSTRACT_OWN, theme: ABSTRACT_OWN,
  coAuthorNames: ABSTRACT_OWN, newStatus: ABSTRACT_OWN, statusHeading: ABSTRACT_OWN, statusMessage: ABSTRACT_OWN,
  reviewNotes: ABSTRACT_OWN, reviewScore: ABSTRACT_OWN,
  // Empty in a saved template (the offer rides only on the built-in
  // confirmation), but set: a copy of that confirmation carries the token.
  travelGrantBlock: AUTHORS, travelGrantBlockText: AUTHORS,
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
