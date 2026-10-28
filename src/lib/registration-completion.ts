import type { Prisma, RegistrationCreatedSource } from "@prisma/client";

/**
 * Whether a registration's own details are complete (docs/ONSITE_DESK_PLAN.md §3.1). The person
 * filled them in on a self-service path, so those rows are complete when created; rows an organiser
 * or a tool created with partial details (dashboard, CSV, EventsAir, contacts import, the agent, a desk
 * walk-in) stay incomplete until the completion form is submitted.
 */
const COMPLETE_ON_CREATE: ReadonlySet<RegistrationCreatedSource> = new Set<RegistrationCreatedSource>([
  "PUBLIC_REGISTER",
  "PUBLIC_SUBMITTER",
  "PUBLIC_COMPLETION_FORM",
  "GROUP_REGISTER",
  // The speaker's details come from their speaker record; the desk never asks them to complete.
  "SPEAKER_COMPANION",
]);

/** The `completedAt` a new registration starts with. */
export function completedAtOnCreate(source: RegistrationCreatedSource | null | undefined, now: Date = new Date()): Date | null {
  return source && COMPLETE_ON_CREATE.has(source) ? now : null;
}

/**
 * Registrations still to complete: not completed, and not cancelled. One `AND` clause, so it can be
 * spread into a where that has its own `status` or `OR` without overwriting either.
 */
export const NOT_COMPLETED_WHERE: Prisma.RegistrationWhereInput = {
  // An account counts as completed too: the account sweeps link rows across events without stamping
  // them, and the link and the form send already treat those as done (review MED).
  AND: [{ completedAt: null }, { userId: null }, { status: { not: "CANCELLED" } }],
};

/** The list filter `completion=pending|done`; anything else (or nothing) filters nothing. */
export function completionWhereFor(param: string | null | undefined): Prisma.RegistrationWhereInput {
  if (param === "pending") return NOT_COMPLETED_WHERE;
  if (param === "done") return { AND: [{ OR: [{ completedAt: { not: null } }, { userId: { not: null } }] }] };
  return {};
}
