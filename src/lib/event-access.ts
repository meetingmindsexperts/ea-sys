import { Prisma } from "@prisma/client";

type SessionUser = {
  id: string;
  role: string;
  organizationId?: string | null;
};

export function buildEventAccessWhere(
  user: SessionUser,
  eventId?: string
): Prisma.EventWhereInput {
  if (user.role === "REVIEWER") {
    // Reviewers are org-independent — scoped only by event assignment
    return {
      ...(eventId && { id: eventId }),
      settings: {
        path: ["reviewerUserIds"],
        array_contains: user.id,
      },
    };
  }

  if (user.role === "SUBMITTER") {
    // Submitters are org-independent — scoped by Speaker.userId linkage
    return {
      ...(eventId && { id: eventId }),
      speakers: { some: { userId: user.id } },
    };
  }

  if (user.role === "REGISTRANT") {
    // Registrants are org-independent — scoped by Registration.userId linkage
    return {
      ...(eventId && { id: eventId }),
      registrations: { some: { userId: user.id } },
    };
  }

  // MEMBER: org-bound read-only viewer — same event scope as ORGANIZER
  if (user.role === "MEMBER") {
    return {
      ...(eventId && { id: eventId }),
      organizationId: user.organizationId!,
    };
  }

  // ONSITE: registration-desk staff, org-bound BUT scoped per-event via
  // Event.settings.onsiteUserIds (mirrors the REVIEWER per-event model). Sees
  // ONLY events it's been assigned to — a temp desk worker for one conference
  // no longer sees every org event. This narrows *event visibility* only; the
  // write guard (denyReviewer), finance hiding (canViewFinance), and nav
  // (proxy.ts) are unchanged. The org filter stops a leaked id from another org
  // from matching; the settings check is the per-event assignment.
  if (user.role === "ONSITE") {
    return {
      ...(eventId && { id: eventId }),
      organizationId: user.organizationId!,
      settings: { path: ["onsiteUserIds"], array_contains: user.id },
    };
  }

  // SUPER_ADMIN: if no org is set (or explicitly cleared), see all events
  if (user.role === "SUPER_ADMIN" && !user.organizationId) {
    return { ...(eventId && { id: eventId }) };
  }

  // Default (ADMIN / ORGANIZER): org-bound, all events in the org. (ONSITE was
  // here historically but is now scoped per-event above.)
  return {
    ...(eventId && { id: eventId }),
    organizationId: user.organizationId!,
  };
}
