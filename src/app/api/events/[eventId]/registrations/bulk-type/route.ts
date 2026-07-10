import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";
import { refreshEventStats } from "@/lib/event-stats";
import { holdsSeat, seatCounter, type SeatCounter } from "@/lib/registration-seat";
import { releaseSeats } from "@/lib/registration-seat-db";

const bulkTypeSchema = z.object({
  registrationIds: z.array(z.string()).min(1).max(500),
  ticketTypeId: z.string().min(1),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams) {
  // Resolved before the try so eventId is in scope for the catch's logs.
  const { eventId } = await params;
  try {
    const [session, body] = await Promise.all([
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
        apiLogger.warn({ msg: "events/registrations/bulk-type:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { registrationIds, ticketTypeId } = validated.data;

    // Verify the target ticket type exists and belongs to this event
    const targetType = await db.ticketType.findFirst({
      where: { id: ticketTypeId, eventId },
      select: { id: true, name: true, quantity: true, price: true },
    });

    if (!targetType) {
      return NextResponse.json({ error: "Registration type not found" }, { status: 404 });
    }

    // Fetch all registrations being moved (only non-cancelled, and not already
    // this type). Need the seat-routing fields so we release the counter each
    // reg actually holds (tier vs ticket type) rather than blindly decrementing
    // the old ticket type (ROADMAP P1.1 fix), plus paymentStatus for the
    // repricing split below.
    const registrations = await db.registration.findMany({
      where: {
        id: { in: registrationIds },
        eventId,
        status: { not: "CANCELLED" },
        ticketTypeId: { not: ticketTypeId },
      },
      select: {
        id: true,
        ticketTypeId: true,
        attendeeId: true,
        pricingTierId: true,
        createdSource: true,
        attendanceMode: true,
        status: true,
        paymentStatus: true,
      },
    });

    if (registrations.length === 0) {
      return NextResponse.json({ updated: 0 });
    }

    // Release side: group each reg's HELD seat by its actual counter (tier or
    // ticket type). A virtual reg holds no seat (skipped). Claim side: only
    // in-person regs claim a seat on the new type — virtual ones just change
    // type. After a type change the old tier is invalid, so all moved rows get
    // pricingTierId nulled (their seat now lives on the new ticket-type counter).
    const releaseCounts = new Map<string, { counter: SeatCounter; count: number }>();
    let claimCount = 0;
    for (const r of registrations) {
      if (!holdsSeat(r.status, r.attendanceMode)) continue;
      claimCount++;
      const counter = seatCounter(r);
      if (!counter) continue;
      const key = `${counter.kind}:${counter.id}`;
      const entry = releaseCounts.get(key);
      if (entry) entry.count++;
      else releaseCounts.set(key, { counter, count: 1 });
    }

    await db.$transaction(async (tx) => {
      // Release each held counter (guarded, never below 0)
      for (const { counter, count } of releaseCounts.values()) {
        await releaseSeats(tx, counter, count);
      }

      // Claim the in-person seats on the new type ATOMICALLY — guard against
      // oversell. `soldCount <= quantity - N` ensures soldCount + N never
      // exceeds the cap even under a concurrent claim. All-or-nothing: if it
      // can't fit, the whole move rolls back (admin raises quantity / moves
      // fewer). Skipped entirely when every moved reg is virtual.
      if (claimCount > 0) {
        const claimed = await tx.ticketType.updateMany({
          where: { id: ticketTypeId, soldCount: { lte: targetType.quantity - claimCount } },
          data: { soldCount: { increment: claimCount } },
        });
        if (claimed.count === 0) {
          throw new Error("CAPACITY_EXCEEDED");
        }
      }

      // Update all registrations — new type + drop the now-invalid tier —
      // and RE-STAMP originalPrice for money-outstanding rows (review H8).
      // `readRegistrationBasePrice` prefers the stamped originalPrice, so
      // without the restamp a $100-Student reg bulk-moved to $400-Physician
      // kept charging $100 on every finance surface (quote PDF, pay-later
      // checkout, refund math). Mirrors resolveRepricing's bare-type-change
      // policy exactly: unpaid (UNASSIGNED/UNPAID/PENDING) → reprice to the
      // NEW type's base; settled rows (PAID/COMPLIMENTARY/INCLUSIVE/…) move
      // type but keep their price — they already paid it.
      const unpaidIds = registrations
        .filter((r) => ["UNASSIGNED", "UNPAID", "PENDING"].includes(r.paymentStatus))
        .map((r) => r.id);
      const settledIds = registrations
        .filter((r) => !["UNASSIGNED", "UNPAID", "PENDING"].includes(r.paymentStatus))
        .map((r) => r.id);
      if (unpaidIds.length > 0) {
        await tx.registration.updateMany({
          where: { id: { in: unpaidIds } },
          data: { ticketTypeId, pricingTierId: null, originalPrice: Number(targetType.price) },
        });
      }
      if (settledIds.length > 0) {
        await tx.registration.updateMany({
          where: { id: { in: settledIds } },
          data: { ticketTypeId, pricingTierId: null },
        });
      }

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
            // Unpaid rows re-stamped to the new type's base price (H8);
            // settled rows kept their paid price.
            repricedCount: registrations.filter((r) =>
              ["UNASSIGNED", "UNPAID", "PENDING"].includes(r.paymentStatus),
            ).length,
            repricedTo: Number(targetType.price),
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
    if (error instanceof Error && error.message === "CAPACITY_EXCEEDED") {
      apiLogger.warn({ msg: "bulk-type:capacity-exceeded", eventId });
      return NextResponse.json(
        {
          error: "That registration type doesn't have enough capacity for all the selected registrations. Increase its quantity or move fewer.",
          code: "CAPACITY_EXCEEDED",
        },
        { status: 409 }
      );
    }
    apiLogger.error({ err: error, msg: "Error in bulk type update" });
    return NextResponse.json(
      { error: "Failed to update registration types" },
      { status: 500 }
    );
  }
}
