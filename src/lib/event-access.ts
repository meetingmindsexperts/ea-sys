import { Prisma } from "@prisma/client";

type SessionUser = {
  id: string;
  role: string;
  organizationId: string;
};

export function buildEventAccessWhere(
  user: SessionUser,
  eventId?: string
): Prisma.EventWhereInput {
  if (user.role === "REVIEWER") {
    return {
      ...(eventId && { id: eventId }),
      organizationId: user.organizationId,
      settings: {
        path: ["reviewerUserIds"],
        array_contains: user.id,
      },
    };
  }

  return {
    ...(eventId && { id: eventId }),
    organizationId: user.organizationId,
  };
}
