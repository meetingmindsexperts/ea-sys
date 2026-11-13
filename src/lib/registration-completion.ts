import type { Prisma, RegistrationCreatedSource } from "@prisma/client";

/**
 * Whether a registration's own details are complete (docs/ONSITE_DESK_PLAN.md §3.1). The person
 * filled them in on a self-service path, so those rows are complete when created; rows an organiser
 * or a tool created with partial details (dashboard, CSV, EventsAir, contacts import, the agent) stay
 * incomplete until the completion form is submitted. The desk walk-in collects every field the public
 * form requires, so it passes `detailsComplete` to `createRegistration()` instead.
 */
const COMPLETE_ON_CREATE: ReadonlySet<RegistrationCreatedSource> = new Set<RegistrationCreatedSource>([
  "PUBLIC_REGISTER",
  "PUBLIC_SUBMITTER",
  "PUBLIC_COMPLETION_FORM",
  "GROUP_REGISTER",
  // The speaker's details come from their speaker record; the desk never asks them to complete.
  "SPEAKER_COMPANION",
  // Added as Faculty by staff, who typed the details (review M1): never "Form
  // not completed", so no completion link can move them off Faculty seatless.
  "FACULTY_ADMIN",
]);

/** The `completedAt` a new registration starts with. */
export function completedAtOnCreate(source: RegistrationCreatedSource | null | undefined, now: Date = new Date()): Date | null {
  return source && COMPLETE_ON_CREATE.has(source) ? now : null;
}

/**
 * Whether a registration's form counts as completed: THE rule every reader asks (the desk's "Form
 * not completed" chip and Complete onsite, the Registrations filter, the detail sheet's Send
 * Registration Form, the onsite link, the completion form itself and the form-link sender).
 *
 * - `completedAt`: the person submitted the form, or the row was complete when created (above).
 * - An account: the account sweeps link rows across events without stamping them (review MED).
 * - The Faculty type (owner, Nov 13, 2026): faculty details are kept by staff on the speaker
 *   record, so the desk never sends a speaker to the form. Read from the TYPE, not stamped on the
 *   row, because a row reaches Faculty by doors that stamp nothing: staff adding it from the
 *   dashboard while "Faculty" was an ordinary type that later became the built-in one (33 rows on
 *   one production event read "Form not completed" with every detail present), or a type change.
 *   A row moved off Faculty is judged by the first two again.
 *
 * Client-safe. A caller that reads from Prisma selects `ticketType: { select: { isFaculty: true } }`
 * beside `completedAt` and `userId`; the where clauses below are the same rule in SQL.
 */
export function isRegistrationFormCompleted(reg: {
  completedAt?: unknown;
  userId?: unknown;
  ticketType?: { isFaculty?: boolean | null } | null;
}): boolean {
  return Boolean(reg.completedAt || reg.userId || reg.ticketType?.isFaculty);
}

/** Not on the Faculty type: no type at all, or an ordinary one. A relation filter alone skips the typeless. */
const NOT_FACULTY_TYPE: Prisma.RegistrationWhereInput = {
  OR: [{ ticketTypeId: null }, { ticketType: { isFaculty: false } }],
};

/**
 * Registrations still to complete: not completed (`isRegistrationFormCompleted`), and not cancelled.
 * One `AND` clause, so it can be spread into a where that has its own `status` or `OR` without
 * overwriting either.
 */
export const NOT_COMPLETED_WHERE: Prisma.RegistrationWhereInput = {
  AND: [{ completedAt: null }, { userId: null }, { status: { not: "CANCELLED" } }, NOT_FACULTY_TYPE],
};

/** The list filter `completion=pending|done`; anything else (or nothing) filters nothing. */
export function completionWhereFor(param: string | null | undefined): Prisma.RegistrationWhereInput {
  if (param === "pending") return NOT_COMPLETED_WHERE;
  if (param === "done") {
    return { AND: [{ OR: [{ completedAt: { not: null } }, { userId: { not: null } }, { ticketType: { isFaculty: true } }] }] };
  }
  return {};
}
