/**
 * Who an attendee is, for the webinar's attendance files (Nov 25, 2026; asked
 * by the webinar team: role, specialty, organisation and country beside each
 * attendee). One reading for both files, the Zoom attendance CSV and the page
 * attendance CSV, and the same one the registrations export uses: Role and
 * Specialty are shown by the organisation's own label for the stored answer
 * (person-fields.ts; an answer not on the list is shown as stored),
 * Organisation and Country as typed. One difference, on purpose: someone who
 * chose "Others" for Specialty and typed their own is shown by what they
 * typed, as on their own details page; "Others" says nothing to the reader of
 * an attendance file.
 *
 * These are staff files, behind the attendance export permission. The
 * post-event report, which is forwarded to clients, names no attendee and does
 * not use this.
 */
import { answerLabel, OTHER_ANSWER, type PersonFieldsConfig } from "@/lib/person-fields";

/** The columns, in the registrations export's own words. */
export const ATTENDEE_PROFILE_HEADERS = ["Role", "Specialty", "Organization", "Country"] as const;

/** What to select from the attendee. */
export const ATTENDEE_PROFILE_SELECT = { role: true, specialty: true, customSpecialty: true, organization: true, country: true } as const;

export interface AttendeeProfileSource {
  role: string | null;
  specialty: string | null;
  /** What the person typed when they chose "Others". */
  customSpecialty?: string | null;
  organization: string | null;
  country: string | null;
}

/** The four cells, in the headers' order. Empty for someone with no registration behind them (a Zoom guest). */
export function attendeeProfileCells(attendee: AttendeeProfileSource | null | undefined, fields: PersonFieldsConfig): [string, string, string, string] {
  if (!attendee) return ["", "", "", ""];
  const typed = attendee.specialty === OTHER_ANSWER ? attendee.customSpecialty?.trim() : "";
  return [
    answerLabel(fields.role, attendee.role),
    typed || answerLabel(fields.specialty, attendee.specialty),
    attendee.organization ?? "",
    attendee.country ?? "",
  ];
}
