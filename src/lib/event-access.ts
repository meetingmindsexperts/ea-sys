import { Prisma } from "@prisma/client";

export type SessionUser = {
  id: string;
  role: string;
  organizationId?: string | null;
};

/**
 * The events an ORG-INDEPENDENT person may open: a reviewer, a submitter or a
 * registrant. Their access comes from a link to the event (a reviewer pool, a
 * speaker row, a registration), which the permission catalogue does not
 * model, so they keep this predicate.
 *
 * Staff do NOT come through here any more (custom roles Phase 6, Oct 6, 2026):
 * every staff lookup asks `requirePermission()` / `eventWhereFor()` for the
 * operation's key, and `requirePermission(..., { linkedRoles })` routes these
 * three roles here. The staff branches that lived in this function (MEMBER,
 * ONSITE, WEBINARS and its "desk" surface, CRM_USER, HR_USER, the operator,
 * the org default) and `accessUserFrom` are gone. Any other role gets NO
 * events: fail closed, so a caller that forgets the permission gate finds
 * nothing rather than the organisation.
 */
export function buildEventAccessWhere(user: SessionUser, eventId?: string): Prisma.EventWhereInput {
  const id = eventId ? { id: eventId } : {};

  // Reviewers: the events whose reviewer pool lists them.
  if (user.role === "REVIEWER") {
    return { ...id, settings: { path: ["reviewerUserIds"], array_contains: user.id } };
  }
  // Submitters: the events where they have a speaker row.
  if (user.role === "SUBMITTER") {
    return { ...id, speakers: { some: { userId: user.id } } };
  }
  // Registrants: the events where they have a registration.
  if (user.role === "REGISTRANT") {
    return { ...id, registrations: { some: { userId: user.id } } };
  }
  return { id: { in: [] } };
}
