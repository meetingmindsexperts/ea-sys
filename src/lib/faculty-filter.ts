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
 * only the auto-created Faculty companions are excluded. `NOT { ticketType
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
 * The professional registration type to DISPLAY for a registration.
 *
 * For a faculty companion (the `isFaculty` ticket type) this returns the
 * person's profession (Physician / Allied Health / Nurse / Others) from the
 * attendee's `registrationType` — NEVER the literal "Faculty" (that's a
 * badge/role, not a profession), falling back to "—" when the profession wasn't
 * recorded. For everyone else it's the ticket-type name, which IS the
 * professional category for a normal delegate. Pure + client-safe.
 */
export function displayRegistrationType(
  input: {
    ticketTypeName?: string | null;
    isFaculty?: boolean | null;
    attendeeRegistrationType?: string | null;
  },
  emptyLabel = "—",
): string {
  if (input.isFaculty) {
    const rt = input.attendeeRegistrationType;
    return rt && rt !== "Faculty" ? rt : emptyLabel;
  }
  return input.ticketTypeName ?? emptyLabel;
}
