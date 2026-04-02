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

  // SUPER_ADMIN: if no org is set (or explicitly cleared), see all events
  if (user.role === "SUPER_ADMIN" && !user.organizationId) {
    return { ...(eventId && { id: eventId }) };
  }

  return {
    ...(eventId && { id: eventId }),
    organizationId: user.organizationId!,
  };
}
