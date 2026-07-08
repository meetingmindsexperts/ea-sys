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
import { rsvpDinnerInputSchema } from "@/lib/rsvp/rsvp";

type RouteParams = { params: Promise<{ eventId: string; dinnerId: string }> };

async function loadDinner(eventId: string, dinnerId: string, organizationId: string) {
  const event = await db.event.findFirst({
    where: { id: eventId, organizationId },
    select: { id: true },
  });
  if (!event) return null;
  return db.rsvpDinner.findFirst({ where: { id: dinnerId, eventId }, select: { id: true } });
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

    const dinner = await loadDinner(eventId, dinnerId, session.user.organizationId!);
    if (!dinner) return NextResponse.json({ error: "Dinner not found" }, { status: 404 });

    const d = parsed.data;
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
          changes: { fields: Object.keys(d) },
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

    const dinner = await loadDinner(eventId, dinnerId, session.user.organizationId!);
    if (!dinner) return NextResponse.json({ error: "Dinner not found" }, { status: 404 });

    await db.rsvpDinner.delete({ where: { id: dinnerId } });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "DELETE",
          entityType: "RSVP_DINNER",
          entityId: dinnerId,
          changes: {},
        },
      })
      .catch((err) => apiLogger.error({ err }, "dinners:audit-failed"));

    return NextResponse.json({ ok: true });
  } catch (err) {
    apiLogger.error({ err }, "dinners:delete-failed");
    return NextResponse.json({ error: "Failed to delete dinner" }, { status: 500 });
  }
}
