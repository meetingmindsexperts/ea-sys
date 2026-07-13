import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";
import { canViewFinance, redactFinancialFields } from "@/lib/finance-visibility";
import { canViewEntryBarcode, redactBarcodeFields } from "@/lib/barcode-visibility";

const updateRoomTypeSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  pricePerNight: z.number().min(0).optional(),
  currency: z.string().max(10).optional(),
  capacity: z.number().min(1).optional(),
  totalRooms: z.number().min(1).optional(),
  amenities: z.array(z.string().max(255)).optional(),
  images: z.array(z.string().url().max(500)).optional(),
  isActive: z.boolean().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; hotelId: string; roomId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { eventId, hotelId, roomId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId!,
      },
      select: { id: true },
    });

    if (!event) {
      apiLogger.warn({ msg: "room-type:event-not-found", eventId, hotelId, roomId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const roomType = await db.roomType.findFirst({
      // H1: the hotel MUST be bound to the (already org-verified) event. Binding
      // only `hotelId` from the URL left the authorization chain broken in the
      // middle — a caller could pass another org's hotelId + roomId against
      // their OWN eventId and read/mutate that org's room type. The sibling
      // rooms/route.ts always did this correctly; this file had drifted.
      where: {
        id: roomId,
        hotel: { id: hotelId, eventId },
      },
      include: {
        hotel: true,
        accommodations: {
          // Only the fields the room-detail view needs. Was `registration:
          // { include: { attendee: true } }` — the FULL Registration row, which
          // carries qrCode + dtcmBarcode (physical-access credentials) and every
          // financial scalar. The redaction below is defence-in-depth; this
          // select is the actual fix (H2).
          select: {
            id: true,
            status: true,
            checkIn: true,
            checkOut: true,
            guestCount: true,
            totalPrice: true,
            registration: {
              select: {
                id: true,
                attendee: {
                  select: { firstName: true, lastName: true, email: true },
                },
              },
            },
            speaker: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
          },
        },
        _count: {
          select: { accommodations: true },
        },
      },
    });

    if (!roomType) {
      apiLogger.warn({ msg: "room-type:not-found", eventId, hotelId, roomId, userId: session.user.id });
      return NextResponse.json({ error: "Room type not found" }, { status: 404 });
    }

    // Compose both boundaries (mirrors the registrations list GET): barcodes are
    // a door credential (MEMBER excluded), prices are finance.
    let payload: typeof roomType = roomType;
    if (!canViewEntryBarcode(session.user.role)) payload = redactBarcodeFields(payload);
    if (!canViewFinance(session.user.role)) payload = redactFinancialFields(payload);

    return NextResponse.json(payload);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching room type" });
    return NextResponse.json(
      { error: "Failed to fetch room type" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const { eventId, hotelId, roomId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId!,
      },
      select: { id: true },
    });

    if (!event) {
      // L4: the cross-org denial is exactly the signal you want when someone is
      // enumerating ids — it used to produce no log line at all.
      apiLogger.warn({ msg: "room-type:event-not-found", eventId, hotelId, roomId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const existingRoomType = await db.roomType.findFirst({
      // H1 — bind the full chain: room → hotel → (org-verified) event.
      where: {
        id: roomId,
        hotel: { id: hotelId, eventId },
      },
    });

    if (!existingRoomType) {
      apiLogger.warn({ msg: "room-type:not-found", op: "update", eventId, hotelId, roomId, userId: session.user.id });
      return NextResponse.json({ error: "Room type not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = updateRoomTypeSchema.safeParse(body);

    if (!validated.success) {
        apiLogger.warn({ msg: "events/hotels/rooms:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    // Ensure totalRooms is not less than bookedRooms
    if (data.totalRooms !== undefined && data.totalRooms < existingRoomType.bookedRooms) {
      return NextResponse.json(
        { error: `Total rooms cannot be less than booked rooms (${existingRoomType.bookedRooms})` },
        { status: 400 }
      );
    }

    const roomType = await db.roomType.update({
      where: { id: roomId },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.description !== undefined && { description: data.description || null }),
        ...(data.pricePerNight !== undefined && { pricePerNight: data.pricePerNight }),
        ...(data.currency && { currency: data.currency }),
        ...(data.capacity !== undefined && { capacity: data.capacity }),
        ...(data.totalRooms !== undefined && { totalRooms: data.totalRooms }),
        ...(data.amenities && { amenities: data.amenities }),
        ...(data.images && { images: data.images }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
      include: {
        _count: {
          select: { accommodations: true },
        },
      },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "RoomType",
        entityId: roomType.id,
        changes: {
          before: existingRoomType,
          after: roomType,
          ip: getClientIp(req),
        },
      },
    });

    return NextResponse.json(roomType);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating room type" });
    return NextResponse.json(
      { error: "Failed to update room type" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { eventId, hotelId, roomId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId!,
      },
      select: { id: true },
    });

    if (!event) {
      // L4: the cross-org denial is exactly the signal you want when someone is
      // enumerating ids — it used to produce no log line at all.
      apiLogger.warn({ msg: "room-type:event-not-found", eventId, hotelId, roomId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const roomType = await db.roomType.findFirst({
      // H1 — bind the full chain: room → hotel → (org-verified) event.
      where: {
        id: roomId,
        hotel: { id: hotelId, eventId },
      },
      include: {
        _count: {
          select: { accommodations: true },
        },
      },
    });

    if (!roomType) {
      apiLogger.warn({ msg: "room-type:not-found", op: "delete", eventId, hotelId, roomId, userId: session.user.id });
      return NextResponse.json({ error: "Room type not found" }, { status: 404 });
    }

    // Don't allow deletion if there are bookings
    if (roomType._count.accommodations > 0) {
      apiLogger.warn({
        msg: "room-type:delete-blocked-has-bookings",
        eventId,
        roomId,
        bookings: roomType._count.accommodations,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "Cannot delete room type with existing bookings" },
        { status: 400 }
      );
    }

    await db.roomType.delete({
      where: { id: roomId },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "RoomType",
        entityId: roomId,
        changes: { deleted: roomType, ip: getClientIp(req) },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting room type" });
    return NextResponse.json(
      { error: "Failed to delete room type" },
      { status: 500 }
    );
  }
}
