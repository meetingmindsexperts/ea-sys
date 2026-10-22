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

/** What a registration on the speakers' type shows when no profession is recorded. */
export const FACULTY_TYPE_FALLBACK = "Faculty";

/**
 * The professional registration type to DISPLAY for a registration.
 *
 * For a faculty companion (the `isFaculty` ticket type) this returns the
 * person's profession (Physician / Allied Health / Nurse / Others) from the
 * attendee's `registrationType` when one is recorded. When none is (empty, or
 * the literal "Faculty"), it shows "Faculty" (owner, Oct 22, 2026): it used to
 * show a dash, which read as missing data when the real reason is that this is
 * a speaker's registration. For everyone else it's the ticket-type name, which
 * IS the professional category for a normal delegate. Pure + client-safe.
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
    return rt && rt !== FACULTY_TYPE_FALLBACK ? rt : FACULTY_TYPE_FALLBACK;
  }
  return input.ticketTypeName ?? emptyLabel;
}

/** How the speakers' automatic type is named in a registration-type picker. */
export const SPEAKERS_TYPE_LABEL = "Faculty (speakers)";

/**
 * The registration types staff may pick for a registration (Oct 22, 2026).
 * The speakers' type is offered only to a registration already on it, so it
 * can be moved off, and never to anyone else: Add Registration hides it too,
 * and picking it by hand left Uzma Sharif (BHS2026) on it with no way back.
 */
export function pickableRegTypes<T extends { id: string; isFaculty?: boolean | null }>(
  types: T[],
  currentTypeId: string | null | undefined,
): T[] {
  return types.filter((t) => !t.isFaculty || t.id === currentTypeId);
}
