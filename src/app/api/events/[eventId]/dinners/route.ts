/**
 * Dinner RSVP — dinners CRUD (organizer).
 *
 *   GET  → list the event's dinners (ordered).
 *   POST → create a dinner (Day 1 Dinner, Day 2 Gala, …).
 *
 * Org-scoped via session; writes are denyReviewer-guarded + rate-limited.
 * Docs: docs/DINNER_RSVP.md.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { rsvpDinnerInputSchema, isDeadlineAfterDinner } from "@/lib/rsvp/rsvp";

type RouteParams = { params: Promise<{ eventId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "dinners:list-event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const dinners = await db.rsvpDinner.findMany({
      where: { eventId },
      orderBy: [{ sortOrder: "asc" }, { dinnerAt: "asc" }],
    });
    return NextResponse.json({ dinners });
  } catch (err) {
    apiLogger.error({ err }, "dinners:list-failed");
    return NextResponse.json({ error: "Failed to load dinners" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `dinners-write:${eventId}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "dinners:create-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const parsed = rsvpDinnerInputSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten(), eventId }, "dinners:create-validation-failed");
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "dinners:create-event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const d = parsed.data;
    if (isDeadlineAfterDinner(d.dinnerAt, d.rsvpDeadline)) {
      apiLogger.warn({ eventId, userId: session.user.id }, "dinners:create-deadline-after-dinner");
      return NextResponse.json(
        { error: "The RSVP deadline cannot be after the dinner itself.", code: "DEADLINE_AFTER_DINNER" },
        { status: 400 },
      );
    }
    const dinner = await db.rsvpDinner.create({
      data: {
        eventId,
        name: d.name,
        dinnerAt: new Date(d.dinnerAt),
        location: d.location || null,
        description: d.description || null,
        rsvpDeadline: d.rsvpDeadline ? new Date(d.rsvpDeadline) : null,
        sortOrder: d.sortOrder ?? 0,
        isActive: d.isActive ?? true,
      },
    });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "CREATE",
          entityType: "RSVP_DINNER",
          entityId: dinner.id,
          changes: { name: dinner.name, dinnerAt: dinner.dinnerAt },
        },
      })
      .catch((err) => apiLogger.error({ err }, "dinners:audit-failed"));

    return NextResponse.json({ dinner }, { status: 201 });
  } catch (err) {
    apiLogger.error({ err }, "dinners:create-failed");
    return NextResponse.json({ error: "Failed to create dinner" }, { status: 500 });
  }
}
