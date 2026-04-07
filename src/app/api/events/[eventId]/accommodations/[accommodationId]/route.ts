import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";

const updateAccommodationSchema = z.object({
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

    const [event, accommodation] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.accommodation.findFirst({
        where: { id: accommodationId, eventId },
        include: {
          registration: {
            include: {
              attendee: true,
              ticketType: true,
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
          roomType: {
            include: {
              hotel: true,
            },
          },
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!accommodation) {
      return NextResponse.json({ error: "Accommodation not found" }, { status: 404 });
    }

    return NextResponse.json(accommodation);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching accommodation" });
    return NextResponse.json(
      { error: "Failed to fetch accommodation" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, accommodationId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, existingAccommodation, body] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.accommodation.findFirst({
        where: { id: accommodationId, eventId },
        include: { roomType: true },
      }),
      req.json(),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!existingAccommodation) {
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
      // Handle room type change
      if (data.roomTypeId && data.roomTypeId !== existingAccommodation.roomTypeId) {
        const freshRoom = await tx.roomType.findUnique({
          where: { id: data.roomTypeId },
          select: { bookedRooms: true, totalRooms: true },
        });
        if (!freshRoom || freshRoom.bookedRooms >= freshRoom.totalRooms) {
          throw new Error("NO_ROOMS_AVAILABLE");
        }
        await tx.roomType.update({
          where: { id: existingAccommodation.roomTypeId },
          data: { bookedRooms: { decrement: 1 } },
        });
        await tx.roomType.update({
          where: { id: data.roomTypeId },
          data: { bookedRooms: { increment: 1 } },
        });
      }

      // Handle cancellation — release room
      if (data.status === "CANCELLED" && existingAccommodation.status !== "CANCELLED") {
        await tx.roomType.update({
          where: { id: existingAccommodation.roomTypeId },
          data: { bookedRooms: { decrement: 1 } },
        });
      } else if (data.status && data.status !== "CANCELLED" && existingAccommodation.status === "CANCELLED") {
        const freshRoom = await tx.roomType.findUnique({
          where: { id: existingAccommodation.roomTypeId },
          select: { bookedRooms: true, totalRooms: true },
        });
        if (!freshRoom || freshRoom.bookedRooms >= freshRoom.totalRooms) {
          throw new Error("NO_ROOMS_AVAILABLE");
        }
        await tx.roomType.update({
          where: { id: existingAccommodation.roomTypeId },
          data: { bookedRooms: { increment: 1 } },
        });
      }

      return tx.accommodation.update({
        where: { id: accommodationId },
        data: {
          ...(data.roomTypeId && { roomTypeId: newRoomTypeId }),
          ...(data.checkIn && { checkIn: new Date(data.checkIn) }),
          ...(data.checkOut && { checkOut: new Date(data.checkOut) }),
          ...(data.guestCount !== undefined && { guestCount: data.guestCount }),
          ...(data.specialRequests !== undefined && { specialRequests: data.specialRequests || null }),
          ...(data.status && { status: data.status }),
          ...(data.confirmationNo !== undefined && { confirmationNo: data.confirmationNo || null }),
          totalPrice,
        },
        include: {
          registration: { include: { attendee: true } },
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
        },
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

    return NextResponse.json(accommodation);
  } catch (error) {
    if (error instanceof Error && error.message === "NO_ROOMS_AVAILABLE") {
      return NextResponse.json({ error: "No rooms available" }, { status: 400 });
    }
    apiLogger.error({ err: error, msg: "Error updating accommodation" });
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

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, accommodation] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.accommodation.findFirst({
        where: { id: accommodationId, eventId },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!accommodation) {
      return NextResponse.json({ error: "Accommodation not found" }, { status: 404 });
    }

    // Atomic transaction: release room + delete accommodation
    await db.$transaction(async (tx) => {
      if (accommodation.status !== "CANCELLED") {
        await tx.roomType.update({
          where: { id: accommodation.roomTypeId },
          data: { bookedRooms: { decrement: 1 } },
        });
      }
      await tx.accommodation.delete({
        where: { id: accommodationId },
      });
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
