import type { Prisma } from "@prisma/client";

/**
 * Faculty companion registrations (the "attendee facet" of a speaker) are on the
 * auto-provisioned `isFaculty` ticket type. They receive all attendee facilities
 * (badge / barcode / DTCM / check-in / survey) but are **excluded from
 * delegate-focused counts/stats** so "Registrations: 150" keeps meaning 150
 * delegates, not 150 + faculty.
 *
 * Keyed on `ticketType.isFaculty` (NOT `createdSource`): a speaker who is ALSO a
 * real registrant has a real ticket type, so they correctly count as a delegate;
 * only registrations on the Faculty type are excluded: a speaker's automatic
 * companion, or someone added as Faculty from Add Registration (committee). `NOT { ticketType
 * isFaculty: true }` also keeps registrations with a null ticketType (legacy).
 *
 * Operational surfaces (badge generation, check-in, survey, DTCM) deliberately
 * do NOT use this — faculty need those facilities.
 */
export const EXCLUDE_FACULTY_WHERE: Prisma.RegistrationWhereInput = {
  NOT: { ticketType: { isFaculty: true } },
};

/** Only faculty companion registrations — for a "Faculty: N" split. */
export const FACULTY_ONLY_WHERE: Prisma.RegistrationWhereInput = {
  ticketType: { isFaculty: true },
};

/**
 * Last resort when a registration on the speakers' type has no profession AND
 * the type has no name to show. Normally the type's own name is used, so each
 * organisation's wording (renamed on Registration Types) shows through.
 */
export const FACULTY_TYPE_FALLBACK = "Faculty";

/**
 * What a speaker's own `registrationType` is saved as when a speaker is made
 * from the Speakers page (Add Speaker, Import from Contacts).
 *
 * That column is served as `registrationType` by GET /api/events/{id}/speakers,
 * and the organisation's website sync (n8n to Webflow) copies it into the
 * site's "registration type" for each person (owner, Nov 12, 2026: "in API,
 * reg type should still be faculty because we use n8n to import to webflow").
 * The team used to pick "Faculty" by hand in a dropdown; the dropdown is gone,
 * so the value is written for them. **The API value is this plain word, never
 * the longer picker label**: changing it changes the public website.
 */
export const SPEAKER_API_REGISTRATION_TYPE = FACULTY_TYPE_FALLBACK;

/**
 * How a registration's type is NAMED, everywhere a person or a program reads
 * it: the Registrations list, the registration sheet, the speaker page, the
 * exports, the shared views and (through speakerApiRegistrationType) the
 * speakers API.
 *
 * One rule (owner, Nov 12, 2026: "short faculty everywhere", and "they should
 * not diverge"):
 *   - a registration on a Faculty type is "Faculty". The plain word, whatever
 *     the type row is called, and never a profession: until that day this
 *     showed the attendee's recorded profession ("Physician") for a Faculty
 *     registration, so one person read Physician on one page and Faculty on
 *     the next. The profession is the Role column's.
 *   - any other registration is its type's own name.
 * `attendeeRegistrationType` is accepted and ignored, so callers need not
 * change; it no longer decides anything. Pure + client-safe.
 */
export function displayRegistrationType(
  input: {
    ticketTypeName?: string | null;
    isFaculty?: boolean | null;
    attendeeRegistrationType?: string | null;
  },
  emptyLabel = "—",
): string {
  if (input.isFaculty) return FACULTY_TYPE_FALLBACK;
  return input.ticketTypeName ?? emptyLabel;
}

/**
 * How the Faculty choice is named in a registration-type picker: the same
 * plain word as everywhere else (owner, Nov 12, 2026). It was "Faculty
 * (speakers and committee)", the bracket being what told it apart from an
 * ordinary type also called "Faculty"; `isFacultyLookalikeName` now keeps such
 * a type out of a picker that offers the real choice.
 */
export const SPEAKERS_TYPE_LABEL = FACULTY_TYPE_FALLBACK;

/**
 * Is this ORDINARY type's name the Faculty choice's own word? A picker that
 * offers the Faculty choice leaves such a type out: two entries reading
 * "Faculty", one of them a delegate type, is how 34 people on the 4th GCC
 * Hematology Hub were registered as delegates. Picking the Faculty choice
 * adopts a free ordinary "Faculty" type anyway (ensureFacultyTicketType).
 */
export function isFacultyLookalikeName(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === FACULTY_TYPE_FALLBACK.toLowerCase();
}

/**
 * The registration types staff may pick for a registration (Oct 22, 2026).
 * The speakers' type is offered only to a registration already on it, so it
 * can be moved off, and never to anyone else: Add Registration offers Faculty
 * only as its own choice (src/lib/faculty-registration.ts), never as the raw type,
 * and picking it by hand left Uzma Sharif (BHS2026) on it with no way back.
 */
export function pickableRegTypes<T extends { id: string; isFaculty?: boolean | null }>(
  types: T[],
  currentTypeId: string | null | undefined,
): T[] {
  return types.filter((t) => !t.isFaculty || t.id === currentTypeId);
}
