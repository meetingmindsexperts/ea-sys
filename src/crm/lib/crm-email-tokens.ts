/**
 * The {{tokens}} a CRM email (deal email, sponsor blast, saved template) may
 * carry. ONE list, read by the server's substitution and by the compose and
 * template dialogs' token chips, so a token offered on screen always resolves
 * in the sent email. Client-safe: its only import is the pure event-time helpers.
 *
 * The event tokens (Oct 27, 2026) take their values from the deal's event (or
 * the blast's event) and come out empty when a deal has no event.
 *
 * NOTE {{eventVenue}} is the venue alone here, with {{eventCity}} beside it;
 * in the event emails it is "venue, city". Kept separate on purpose so a
 * sponsor email can write "at {{eventVenue}} in {{eventCity}}".
 */
import { formatEventDateRange, resolveTimezone } from "@/lib/event-time";

export const CRM_EMAIL_TOKEN_KEYS = [
  "firstName",
  "lastName",
  "companyName",
  "eventName",
  "eventVenue",
  "eventCity",
  "eventCountry",
  "eventStartDate",
  "eventEndDate",
  "eventDates",
  // The person sending (Oct 27, 2026): from their user profile.
  "senderName",
  "senderEmail",
] as const;

export type CrmEmailTokenKey = (typeof CRM_EMAIL_TOKEN_KEYS)[number];

/**
 * The sender's profile signature (Profile → Email Signature), as HTML: the
 * same token name the event emails use. It is placed where written, and then
 * not added again at the end; without it, the signature goes at the end.
 * Kept out of CRM_EMAIL_TOKEN_RE because it is inserted as HTML, not escaped.
 */
export const SIGNATURE_TOKEN = "organizerSignature";
export const SIGNATURE_TOKEN_RE = /\{\{\s*organizerSignature\s*\}\}/g;

/** Every token the dialogs offer, signature included. */
export const CRM_EMAIL_TOKENS = [...CRM_EMAIL_TOKEN_KEYS, SIGNATURE_TOKEN].map((k) => `{{${k}}}`);

/** Matches any CRM token, tolerating spaces inside the braces. Global: reset by replace(). */
export const CRM_EMAIL_TOKEN_RE = new RegExp(`\\{\\{\\s*(${CRM_EMAIL_TOKEN_KEYS.join("|")})\\s*\\}\\}`, "g");

export interface CrmEmailEvent {
  name: string;
  startDate: Date;
  endDate: Date;
  timezone: string | null;
  venue: string | null;
  city: string | null;
  country: string | null;
}

export type CrmEventVars = Record<
  Exclude<CrmEmailTokenKey, "firstName" | "lastName" | "companyName" | "senderName" | "senderEmail">,
  string
>;

// The greeting word must end at a space, punctuation or the end: "Hi-tech
// partners" and "Highlights" are not greetings.
const GREETING_RE = /^(dear|hi|hello|hey|greetings|good\s+(morning|afternoon|evening))(?=[\s,!.:;]|$)/i;

/**
 * Does the message already open with a greeting? Then the CRM's own "Dear
 * {{firstName}}," is left out (Oct 27, 2026: "Dear Saleh, Dear Saleh" when a
 * message or saved template began with its own greeting). Reads the text the
 * reader sees first, ignoring tags, spaces and &nbsp;.
 */
export function startsWithGreeting(html: string): boolean {
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return GREETING_RE.test(text);
}

/** "Friday, October 2, 2026", in the event's own timezone (the event emails' {{eventDate}} format). */
function longDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: tz }).format(d);
}

/**
 * The event half of a CRM email's tokens. Dates read in the event's timezone, as
 * on the event emails, so a 2am Dubai start is not the previous day. No event
 * (a deal not linked to one) gives empty strings, never "TBA": the sender wrote
 * the sentence around the token and a placeholder would read as a real venue.
 */
export function crmEventVars(event: CrmEmailEvent | null): CrmEventVars {
  if (!event) {
    return { eventName: "", eventVenue: "", eventCity: "", eventCountry: "", eventStartDate: "", eventEndDate: "", eventDates: "" };
  }
  const tz = resolveTimezone(event.timezone);
  const start = new Date(event.startDate);
  const end = new Date(event.endDate ?? event.startDate);
  return {
    eventName: event.name,
    eventVenue: event.venue ?? "",
    eventCity: event.city ?? "",
    eventCountry: event.country ?? "",
    eventStartDate: longDate(start, tz),
    eventEndDate: longDate(end, tz),
    eventDates: formatEventDateRange(start, end, tz),
  };
}
