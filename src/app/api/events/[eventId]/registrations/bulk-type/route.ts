import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";
import { refreshEventStats } from "@/lib/event-stats";

const bulkTypeSchema = z.object({
  registrationIds: z.array(z.string()).min(1).max(500),
  ticketTypeId: z.string().min(1),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const validated = bulkTypeSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { registrationIds, ticketTypeId } = validated.data;

    // Verify the target ticket type exists and belongs to this event
    const targetType = await db.ticketType.findFirst({
      where: { id: ticketTypeId, eventId },
      select: { id: true, name: true },
    });

    if (!targetType) {
      return NextResponse.json({ error: "Registration type not found" }, { status: 404 });
    }

    // Fetch all registrations being moved (only non-cancelled, and not already this type)
    const registrations = await db.registration.findMany({
      where: {
        id: { in: registrationIds },
        eventId,
        status: { not: "CANCELLED" },
        ticketTypeId: { not: ticketTypeId },
      },
      select: { id: true, ticketTypeId: true, attendeeId: true },
    });

    if (registrations.length === 0) {
      return NextResponse.json({ updated: 0 });
    }

    // Group by old ticket type to batch soldCount decrements
    const oldTypeCounts = new Map<string, number>();
    for (const r of registrations) {
      if (r.ticketTypeId) {
        oldTypeCounts.set(r.ticketTypeId, (oldTypeCounts.get(r.ticketTypeId) || 0) + 1);
      }
    }

    await db.$transaction(async (tx) => {
      // Decrement old types
      for (const [oldTypeId, count] of oldTypeCounts) {
        await tx.ticketType.update({
          where: { id: oldTypeId },
          data: { soldCount: { decrement: count } },
        });
      }

      // Increment new type
      await tx.ticketType.update({
        where: { id: ticketTypeId },
        data: { soldCount: { increment: registrations.length } },
      });

      // Update all registrations
      await tx.registration.updateMany({
        where: { id: { in: registrations.map((r) => r.id) } },
        data: { ticketTypeId },
      });

      // Sync attendee.registrationType
      await tx.attendee.updateMany({
        where: { id: { in: registrations.map((r) => r.attendeeId) } },
        data: { registrationType: targetType.name },
      });
    });

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    // Audit log (non-blocking)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "Registration",
        entityId: "bulk",
        changes: {
          bulkTypeChange: {
            registrationIds: registrations.map((r) => r.id),
            toTicketTypeId: ticketTypeId,
            toName: targetType.name,
            count: registrations.length,
          },
          ip: getClientIp(req),
        },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    apiLogger.info({
      msg: "Bulk registration type update",
      eventId,
      ticketTypeId,
      count: registrations.length,
      userId: session.user.id,
    });

    return NextResponse.json({ updated: registrations.length });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error in bulk type update" });
    return NextResponse.json(
      { error: "Failed to update registration types" },
      { status: 500 }
    );
  }
}
