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
}

const ALL = { audiences: "all" } as const;
const SPEAKERS = { audiences: ["speakers"] } as const;
const PRESENTERS = { audiences: ["speakers", "abstracts"] } as const;
const AUTHORS = { audiences: ["abstracts"] } as const;
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
  abstractNumber: AUTHORS, abstractTitle: AUTHORS, presentationType: AUTHORS, theme: AUTHORS,
  coAuthorNames: AUTHORS, newStatus: AUTHORS, statusHeading: AUTHORS, statusMessage: AUTHORS,
  reviewNotes: AUTHORS, reviewScore: AUTHORS,
  // Empty in a saved template (the offer rides only on the built-in
  // confirmation), but set: a copy of that confirmation carries the token.
  travelGrantBlock: AUTHORS, travelGrantBlockText: AUTHORS,
} as const satisfies Record<string, EmailToken>;

export type EmailTokenKey = keyof typeof EMAIL_TOKEN_MAP;

/** The tokens a send to this audience sets (RSVP tokens only with `withRsvp`). */
export function tokensSetFor(audience: BulkEmailAudience, opts: { withRsvp?: boolean } = {}): EmailTokenKey[] {
  return (Object.keys(EMAIL_TOKEN_MAP) as EmailTokenKey[]).filter((key) => {
    const token: EmailToken = EMAIL_TOKEN_MAP[key];
    if (token.needsRsvp && !opts.withRsvp) return false;
    return token.audiences === "all" || token.audiences.includes(audience);
  });
}

const AUDIENCE_NOUN: Record<BulkEmailAudience, string> = {
  registrations: "registrations",
  speakers: "speakers",
  reviewers: "reviewers",
  abstracts: "abstract authors",
};

/**
 * What a saved template sent to `audience` names (pass its subject and HTML,
 * what the send's own guard refuses on) that the send will not set, so every
 * email would be refused: a sentence for the sender, or null. Asked
 * when the send is scheduled (precheckBulkEmailViability), not found out when
 * it fires. The RSVP tokens count as set: the RSVP check beside it owns them.
 */
export function savedTemplateTokenRefusal(
  audience: BulkEmailAudience,
  ...texts: Array<string | null | undefined>
): { message: string; tokens: string[] } | null {
  const set = new Set<string>(tokensSetFor(audience, { withRsvp: true }));
  const tokens = findUnresolvedTokens(...texts.map((t) => normalizeTemplateTokens(t ?? ""))).filter((t) => !set.has(t));
  if (tokens.length === 0) return null;
  const parts = tokens.map((t) => {
    const token: EmailToken | undefined = (EMAIL_TOKEN_MAP as Record<string, EmailToken>)[t];
    if (!token || token.audiences === "all") return `{{${t}}} is not a token a saved template can use (check its spelling)`;
    return `{{${t}}} is filled only when sending to ${token.audiences.map((a) => AUDIENCE_NOUN[a]).join(" or ")}`;
  });
  return {
    tokens,
    message: `This template cannot go to ${AUDIENCE_NOUN[audience]} as it is: ${parts.join("; ")}. Change it under Communications, Email Templates, then try again.`,
  };
}

/**
 * The values of the tokens EVERY audience gets that are not the person's name
 * or the event block: what the bulk pipeline has always set, here so a send
 * from one person's record sets the same (step 0; the bulk pipeline moves onto
 * it in step 2). The block tokens are empty until their own audience's branch
 * fills them. Spread it FIRST: a sender's own value wins.
 */
export function everyAudienceTokenValues(p: {
  eventStartDate: Date | null | undefined;
  eventAddress: string | null | undefined;
  personId: string;
  firstName: string;
  lastName: string;
  serialId?: number | null;
  ticketTypeName?: string | null;
  personalMessage?: string | null;
}) {
  return {
    eventAddress: p.eventAddress || "",
    daysUntilEvent: p.eventStartDate
      ? Math.max(1, Math.ceil((new Date(p.eventStartDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : 1,
    speakerName: `${p.firstName} ${p.lastName}`,
    personalMessage: p.personalMessage || "",
    subject: "",
    message: p.personalMessage || "",
    ticketType: p.ticketTypeName || "General Admission",
    registrationId: p.serialId != null ? String(p.serialId).padStart(3, "0") : p.personId.slice(-8).toUpperCase(),
    presentationDetails: "", presentationDetailsText: "",
    moderatorDetails: "", moderatorDetailsText: "", sessionDetails: "",
    agreementLink: "", agreementBlock: "", agreementBlockText: "", agreementAttachment: "",
    entryBarcode: "", entryBarcodeText: "", paymentBlock: "",
  } satisfies Partial<Record<EmailTokenKey, string | number>>;
}
