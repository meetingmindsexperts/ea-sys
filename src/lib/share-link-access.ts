import type { Prisma } from "@prisma/client";
/**
 * The organiser side of every shared-view route (abstracts, proposals,
 * registrations): after the handler's own auth() + denyReviewer (kept literal
 * in each handler so the refusal log names the verb), the org guard and the
 * access-scoped event lookup. One implementation for all five route files.
 */
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { requireOrgId } from "@/lib/require-org";

export async function resolveShareEvent(
  session: Session,
  route: string,
  eventId: string,
  /** The permission gate's filter, from a route moved onto `requirePermission`. */
  where: Prisma.EventWhereInput = buildEventAccessWhere(session.user, eventId),
) {
  const org = requireOrgId(session, { route, eventId });
  if ("error" in org) return { error: org.error } as const;
  const event = await db.event.findFirst({
    where,
    select: { id: true, slug: true, organizationId: true },
  });
  if (!event) {
    apiLogger.warn({ msg: "share-links:event-not-found", eventId, userId: session.user.id, route });
    return { error: NextResponse.json({ error: "Event not found" }, { status: 404 }) } as const;
  }
  return { event } as const;
}

/** "First Last" per user id, for the "last changed by" line. */
export async function userNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, firstName: true, lastName: true },
  });
  return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
}
