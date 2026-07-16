/**
 * Dinner RSVP — single dinner update / delete (organizer).
 *   PUT    → edit a dinner.
 *   DELETE → remove a dinner (cascades its RsvpDinnerResponse rows).
 * Docs: docs/DINNER_RSVP.md.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { rsvpDinnerInputSchema, isDeadlineAfterDinner } from "@/lib/rsvp/rsvp";

type RouteParams = { params: Promise<{ eventId: string; dinnerId: string }> };

async function loadDinner(
  eventId: string,
  dinnerId: string,
  user: { id: string; role: string; organizationId?: string | null },
) {
  const event = await db.event.findFirst({
    // buildEventAccessWhere (R2 L9): assignment-aware + org-null-SUPER_ADMIN
    // correct, replacing the bare organizationId! scope.
    where: buildEventAccessWhere(user, eventId),
    select: { id: true },
  });
  if (!event) return null;
  // Full row — the PUT validates the effective deadline/dinnerAt pair against
  // stored values, and both mutations audit a before-snapshot (review R2 L13:
  // "fields-only" UPDATE audits and `{}` DELETE audits couldn't answer what
  // changed or what was deleted).
  return db.rsvpDinner.findFirst({
    where: { id: dinnerId, eventId },
    select: {
      id: true,
      name: true,
      dinnerAt: true,
      location: true,
      description: true,
      rsvpDeadline: true,
      sortOrder: true,
      isActive: true,
    },
  });
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, dinnerId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;

    const parsed = rsvpDinnerInputSchema.partial().safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten(), eventId, dinnerId }, "dinners:update-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const dinner = await loadDinner(eventId, dinnerId, session.user);
    if (!dinner) {
      apiLogger.warn({ eventId, dinnerId, userId: session.user.id }, "dinners:update-not-found");
      return NextResponse.json({ error: "Dinner not found" }, { status: 404 });
    }

    const d = parsed.data;
    // Effective (merged) cross-field check — the PUT is partial, so either
    // side of the pair may come from the stored row (review R2 L7).
    const effectiveDinnerAt = d.dinnerAt !== undefined ? d.dinnerAt : dinner.dinnerAt;
    const effectiveDeadline = d.rsvpDeadline !== undefined ? d.rsvpDeadline : dinner.rsvpDeadline;
    if (isDeadlineAfterDinner(effectiveDinnerAt, effectiveDeadline)) {
      apiLogger.warn({ eventId, dinnerId, userId: session.user.id }, "dinners:update-deadline-after-dinner");
      return NextResponse.json(
        { error: "The RSVP deadline cannot be after the dinner itself.", code: "DEADLINE_AFTER_DINNER" },
        { status: 400 },
      );
    }
    const updated = await db.rsvpDinner.update({
      where: { id: dinnerId },
      data: {
        ...(d.name !== undefined && { name: d.name }),
        ...(d.dinnerAt !== undefined && { dinnerAt: new Date(d.dinnerAt) }),
        ...(d.location !== undefined && { location: d.location || null }),
        ...(d.description !== undefined && { description: d.description || null }),
        ...(d.rsvpDeadline !== undefined && {
          rsvpDeadline: d.rsvpDeadline ? new Date(d.rsvpDeadline) : null,
        }),
        ...(d.sortOrder !== undefined && { sortOrder: d.sortOrder }),
        ...(d.isActive !== undefined && { isActive: d.isActive }),
      },
    });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "RSVP_DINNER",
          entityId: dinnerId,
          changes: { before: dinner, after: d },
        },
      })
      .catch((err) => apiLogger.error({ err }, "dinners:audit-failed"));

    return NextResponse.json({ dinner: updated });
  } catch (err) {
    apiLogger.error({ err }, "dinners:update-failed");
    return NextResponse.json({ error: "Failed to update dinner" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, dinnerId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;

    const dinner = await loadDinner(eventId, dinnerId, session.user);
    if (!dinner) {
      apiLogger.warn({ eventId, dinnerId, userId: session.user.id }, "dinners:delete-not-found");
      return NextResponse.json({ error: "Dinner not found" }, { status: 404 });
    }

    await db.rsvpDinner.delete({ where: { id: dinnerId } });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "DELETE",
          entityType: "RSVP_DINNER",
          entityId: dinnerId,
          changes: { deleted: dinner },
        },
      })
      .catch((err) => apiLogger.error({ err }, "dinners:audit-failed"));

    return NextResponse.json({ ok: true });
  } catch (err) {
    apiLogger.error({ err }, "dinners:delete-failed");
    return NextResponse.json({ error: "Failed to delete dinner" }, { status: 500 });
  }
}
