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

  return {
    ...(eventId && { id: eventId }),
    organizationId: user.organizationId!,
  };
}
