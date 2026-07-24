import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";
import { optimisticLockField } from "@/lib/optimistic-lock";
import { planRoomTransition, applyRoomTransition, releaseRoom } from "@/lib/accommodation-rooms";
import { canViewFinance, redactFinancialFields } from "@/lib/finance-visibility";
import { canViewEntryBarcode, redactBarcodeFields } from "@/lib/barcode-visibility";

/**
 * H2: the booking payloads used to embed the FULL Registration row via
 * `include: { registration: { include: { attendee: true } } }` — which carries
 * `qrCode` + `dtcmBarcode` (physical-access credentials) and every financial
 * scalar, with no redaction. That handed a MEMBER (read-only, sponsor-side —
 * deliberately excluded from BARCODE_ROLES) every booked guest's door
 * credential, straight past the July-11 barcode-visibility boundary.
 *
 * Fix = an explicit allow-list. `select` is the safe default: when a sensitive
 * column is added to Registration later, `select` keeps it private by
 * construction whereas `include` would leak it automatically.
 */
const BOOKING_PERSON_INCLUDE = {
  registration: {
    select: {
      id: true,
      serialId: true,
      status: true,
      attendee: {
        select: { firstName: true, lastName: true, email: true, phone: true },
      },
      ticketType: { select: { id: true, name: true } },
    },
  },
  speaker: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      title: true,
      organization: true,
    },
  },
  roomType: { include: { hotel: true } },
} as const;

/** Compose the two independent visibility boundaries (mirrors the registrations
 *  list GET): barcodes are a door credential (MEMBER excluded), prices are
 *  finance (MEMBER included). Defence-in-depth behind the select above. */
function redactBooking<T>(value: T, role: string | null | undefined): T {
  let out = value;
  if (!canViewEntryBarcode(role)) out = redactBarcodeFields(out);
  if (!canViewFinance(role)) out = redactFinancialFields(out);
  return out;
}

const updateAccommodationSchema = z.object({
  ...optimisticLockField,
  roomTypeId: z.string().optional(),
  checkIn: z.string().datetime().optional(),
  checkOut: z.string().datetime().optional(),
  guestCount: z.number().min(1).optional(),
  specialRequests: z.string().optional(),
  status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "CHECKED_IN", "CHECKED_OUT"]).optional(),
  confirmationNo: z.string().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; accommodationId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, accommodationId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const [event, accommodation] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: orgGuard.orgId },
        select: { id: true },
      }),
      db.accommodation.findFirst({
        where: { id: accommodationId, eventId },
        include: BOOKING_PERSON_INCLUDE,
      }),
    ]);

    if (!event) {
      apiLogger.warn({ msg: "accommodation:event-not-found", eventId, accommodationId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!accommodation) {
      apiLogger.warn({ msg: "accommodation:not-found", eventId, accommodationId, userId: session.user.id });
      return NextResponse.json({ error: "Accommodation not found" }, { status: 404 });
    }

    return NextResponse.json(redactBooking(accommodation, session.user.role));
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching accommodation" });
    return NextResponse.json(
      { error: "Failed to fetch accommodation" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  // Hoisted so the catch below can name WHICH booking failed — the error paths
  // used to log with no context at all (e.g. a bare "stale-write-rejected").
  const { eventId, accommodationId } = await params;
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, existingAccommodation, body] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: orgGuard.orgId },
        select: { id: true },
      }),
      db.accommodation.findFirst({
        where: { id: accommodationId, eventId },
        include: { roomType: true },
      }),
      req.json(),
    ]);

    if (!event) {
      apiLogger.warn({ msg: "accommodation:event-not-found", op: "update", eventId, accommodationId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!existingAccommodation) {
      apiLogger.warn({ msg: "accommodation:not-found", op: "update", eventId, accommodationId, userId: session.user.id });
      return NextResponse.json({ error: "Accommodation not found" }, { status: 404 });
    }

    const validated = updateAccommodationSchema.safeParse(body);

    if (!validated.success) {
      apiLogger.warn({ msg: "Accommodation update validation failed", accommodationId, eventId, errors: validated.error.flatten(), userId: session.user.id });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;
    if (!data.expectedUpdatedAt) {
      apiLogger.warn({
        msg: "optimistic-lock:missing-expectedUpdatedAt",
        resource: "accommodation",
        resourceId: accommodationId,
      });
    }
    let totalPrice: number = Number(existingAccommodation.totalPrice);
    let newRoomTypeId = existingAccommodation.roomTypeId;

    // Handle room type change — validate before transaction
    if (data.roomTypeId && data.roomTypeId !== existingAccommodation.roomTypeId) {
      const newRoomType = await db.roomType.findFirst({
        where: {
          id: data.roomTypeId,
          isActive: true,
          hotel: { eventId, isActive: true },
        },
      });

      if (!newRoomType) {
        return NextResponse.json({ error: "Room type not found or inactive" }, { status: 404 });
      }

      newRoomTypeId = data.roomTypeId;

      // Recalculate price
      const checkInDate = data.checkIn ? new Date(data.checkIn) : existingAccommodation.checkIn;
      const checkOutDate = data.checkOut ? new Date(data.checkOut) : existingAccommodation.checkOut;
      const nights = Math.ceil(
        (checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (nights <= 0) {
        return NextResponse.json(
          { error: "Check-out must be after check-in" },
          { status: 400 }
        );
      }

      totalPrice = Number(newRoomType.pricePerNight) * nights;
    } else if (data.checkIn || data.checkOut) {
      const checkInDate = data.checkIn ? new Date(data.checkIn) : existingAccommodation.checkIn;
      const checkOutDate = data.checkOut ? new Date(data.checkOut) : existingAccommodation.checkOut;
      const nights = Math.ceil(
        (checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (nights <= 0) {
        return NextResponse.json(
          { error: "Check-out must be after check-in" },
          { status: 400 }
        );
      }

      totalPrice = Number(existingAccommodation.roomType.pricePerNight) * nights;
    }

    // Atomic transaction: update accommodation + adjust room counts together
    const accommodation = await db.$transaction(async (tx) => {
      // ── Claim the row FIRST, conditional on the state we planned from ──
      // (review H5) The counter plan below is derived from `existingAccommodation`,
      // which was read BEFORE the transaction. If someone else changed the status
      // in the meantime (a second tab cancelling, or MCP), that plan is garbage —
      // applying it would release a room twice or claim one twice. So the write
      // is conditional on the status still being what we read: the DB decides who
      // wins, and the loser touches no counter at all.
      //
      // `expectedUpdatedAt` (the optimistic-lock token) is an ADDITIONAL guard,
      // but it is optional — so it cannot be the thing that protects the counter.
      // The status predicate is not optional.
      const lockedUpdate = await tx.accommodation.updateMany({
        where: {
          id: accommodationId,
          status: existingAccommodation.status,
          ...(data.expectedUpdatedAt && { updatedAt: new Date(data.expectedUpdatedAt) }),
        },
        data: {
          ...(data.roomTypeId && { roomTypeId: newRoomTypeId }),
          ...(data.checkIn && { checkIn: new Date(data.checkIn) }),
          ...(data.checkOut && { checkOut: new Date(data.checkOut) }),
          ...(data.guestCount !== undefined && { guestCount: data.guestCount }),
          ...(data.specialRequests !== undefined && { specialRequests: data.specialRequests || null }),
          ...(data.status && { status: data.status }),
          ...(data.confirmationNo !== undefined && { confirmationNo: data.confirmationNo || null }),
          totalPrice,
          updatedAt: new Date(),
        },
      });
      if (lockedUpdate.count === 0) {
        // Distinguish "gone" from "changed under us" so the caller gets the
        // right status code (404 vs 409).
        const stillThere = await tx.accommodation.findUnique({
          where: { id: accommodationId },
          select: { id: true },
        });
        throw new Error(stillThere ? "STALE_WRITE" : "ACCOMMODATION_DISAPPEARED");
      }

      // ── Now move the counters, ONCE, from the whole before→after pair ──
      // (review H3) There used to be two independent blocks here — one for a
      // room-type change, one for a status change — and they double-counted:
      // changing the room type AND cancelling in one request released the OLD
      // room type twice. `planRoomTransition` computes the single net movement,
      // so that class of bug is now structurally impossible.
      const plan = planRoomTransition(
        { status: existingAccommodation.status, roomTypeId: existingAccommodation.roomTypeId },
        { status: data.status ?? existingAccommodation.status, roomTypeId: newRoomTypeId },
      );
      await applyRoomTransition(tx, plan);

      return tx.accommodation.findUniqueOrThrow({
        where: { id: accommodationId },
        include: BOOKING_PERSON_INCLUDE,
      });
    });

    // Non-blocking audit log
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "Accommodation",
        entityId: accommodation.id,
        changes: {
          before: existingAccommodation,
          after: accommodation,
          ip: getClientIp(req),
        },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log for accommodation update" }));

    return NextResponse.json(redactBooking(accommodation, session.user.role));
  } catch (error) {
    if (error instanceof Error && error.message === "NO_ROOMS_AVAILABLE") {
      apiLogger.warn({ msg: "accommodation:no-rooms-available", eventId, accommodationId });
      return NextResponse.json({ error: "No rooms available" }, { status: 400 });
    }
    if (error instanceof Error && error.message === "STALE_WRITE") {
      apiLogger.warn({ msg: "accommodation:stale-write-rejected", eventId, accommodationId });
      return NextResponse.json(
        {
          error: "This booking was modified by someone else after you opened it. Reload the latest version and try again.",
          code: "STALE_WRITE",
        },
        { status: 409 }
      );
    }
    if (error instanceof Error && error.message === "ACCOMMODATION_DISAPPEARED") {
      apiLogger.warn({ msg: "accommodation:disappeared-mid-update", eventId, accommodationId });
      return NextResponse.json({ error: "Accommodation not found" }, { status: 404 });
    }
    apiLogger.error({ err: error, msg: "Error updating accommodation", eventId, accommodationId });
    return NextResponse.json(
      { error: "Failed to update accommodation" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, accommodationId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, accommodation] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: orgGuard.orgId },
        select: { id: true },
      }),
      db.accommodation.findFirst({
        where: { id: accommodationId, eventId },
      }),
    ]);

    if (!event) {
      apiLogger.warn({ msg: "accommodation:event-not-found", op: "delete", eventId, accommodationId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!accommodation) {
      apiLogger.warn({ msg: "accommodation:not-found", op: "delete", eventId, accommodationId, userId: session.user.id });
      return NextResponse.json({ error: "Accommodation not found" }, { status: 404 });
    }

    // Atomic transaction: release room + delete accommodation.
    //
    // (review H6) This used to decide whether to release from the PRE-transaction
    // read — `if (accommodation.status !== "CANCELLED")`. If a concurrent cancel
    // committed between that read and this transaction, the room had ALREADY been
    // released and we released it a second time (one held room, two releases →
    // with the old unguarded decrement, a negative counter).
    //
    // Now the DELETE itself carries the precondition: we delete the row *only if
    // it still holds a room*, and release exactly when that delete matched. The
    // database, not a stale snapshot, decides which branch we're in.
    await db.$transaction(async (tx) => {
      const deletedHolding = await tx.accommodation.deleteMany({
        where: { id: accommodationId, status: { not: "CANCELLED" } },
      });

      if (deletedHolding.count === 1) {
        // We deleted a booking that was holding a room → release it (guarded).
        await releaseRoom(tx, accommodation.roomTypeId);
        return;
      }

      // Either it was already CANCELLED (holds no room — nothing to release) or
      // it's already gone. Delete idempotently, touch no counter.
      await tx.accommodation.deleteMany({ where: { id: accommodationId } });
    });

    // Non-blocking audit log
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "Accommodation",
        entityId: accommodationId,
        changes: { deleted: accommodation, ip: getClientIp(req) },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log for accommodation delete" }));

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting accommodation" });
    return NextResponse.json(
      { error: "Failed to delete accommodation" },
      { status: 500 }
    );
  }
}
