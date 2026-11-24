/**
 * THE answer to "how do I reach the event team" (Nov 24, 2026; owner: "better
 * we add phone number and office timings").
 *
 * - Email: the event's own support email (`Event.supportEmail`), as before.
 * - Phone and office hours: the ORGANISATION's (`Organization.settings.supportContact`,
 *   Settings, Organization), which every event uses; an event may give its own
 *   (`Event.settings.supportContact`, the event's Settings, Support), and then
 *   its own wins for that event. A field left empty on the event falls back to
 *   the organisation's, each field on its own.
 * - Office hours are one line of text the organiser writes ("Monday to Friday,
 *   9:00 to 18:00, Dubai time"), repeated as written: holidays and Ramadan
 *   hours are an edit of that line.
 *
 * Read by the help chat's answer to people outside the organising team
 * (`help-chat/event-facts.ts`). Pure and client-safe.
 */
import { z } from "zod";

export const SUPPORT_CONTACT_SETTING = "supportContact";
export const MAX_SUPPORT_PHONE = 40;
export const MAX_SUPPORT_HOURS = 200;

/**
 * One line: control characters removed, inner whitespace (newlines included)
 * collapsed, trimmed. Empty is "not given".
 */
function oneLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.slice(0, max);
}

/** The fewest digits a phone may have: no real number is shorter, and "(" is not a phone. */
export const MIN_SUPPORT_PHONE_DIGITS = 6;

/**
 * What a save sends: both optional, "" clears, and null clears both. A phone
 * is digits with the usual separators and an optional leading +, with at least
 * MIN_SUPPORT_PHONE_DIGITS digits, so nothing else can be typed into a line
 * the help chat repeats to the public.
 */
export const supportContactSchema = z
  .object({
    phone: z
      .string()
      .max(MAX_SUPPORT_PHONE)
      .regex(/^\s*(\+?[0-9(][0-9 ().-]*)?\s*$/, "Use digits, spaces, brackets, dots or dashes, with an optional + at the start")
      .refine((v) => v.trim() === "" || (v.match(/\d/g)?.length ?? 0) >= MIN_SUPPORT_PHONE_DIGITS, {
        message: `A phone number has at least ${MIN_SUPPORT_PHONE_DIGITS} digits`,
      })
      .optional(),
    hours: z.string().max(MAX_SUPPORT_HOURS).optional(),
  })
  .nullable();
export type SupportContactInput = z.infer<typeof supportContactSchema>;

export interface SupportContact {
  phone: string | null;
  hours: string | null;
}

/** The contact stored on an organisation's or an event's `settings`. Anything malformed reads as not given. */
export function readSupportContact(settings: unknown): SupportContact {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>)[SUPPORT_CONTACT_SETTING] : null;
  if (!raw || typeof raw !== "object") return { phone: null, hours: null };
  const { phone, hours } = raw as Record<string, unknown>;
  return { phone: oneLine(phone, MAX_SUPPORT_PHONE), hours: oneLine(hours, MAX_SUPPORT_HOURS) };
}

/** The value a save stores: cleaned, with an emptied field removed rather than kept as "". */
export function storedSupportContact(input: SupportContactInput): Partial<Record<"phone" | "hours", string>> {
  const phone = oneLine(input?.phone, MAX_SUPPORT_PHONE);
  const hours = oneLine(input?.hours, MAX_SUPPORT_HOURS);
  return { ...(phone && { phone }), ...(hours && { hours }) };
}

/** Does a page's state match what was loaded? A save sends the contact only when it does not. */
export function sameSupportContact(a: SupportContactInput, b: SupportContactInput): boolean {
  return JSON.stringify(storedSupportContact(a)) === JSON.stringify(storedSupportContact(b));
}

/** The event's own phone and hours where it gives them, the organisation's otherwise, field by field. */
export function effectiveSupportContact(orgSettings: unknown, eventSettings: unknown): SupportContact {
  const org = readSupportContact(orgSettings);
  const event = readSupportContact(eventSettings);
  return { phone: event.phone ?? org.phone, hours: event.hours ?? org.hours };
}
