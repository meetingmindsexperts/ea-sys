import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

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

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { eventId, accommodationId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const accommodation = await db.accommodation.findFirst({
      where: {
        id: accommodationId,
        eventId,
      },
      include: {
        registration: {
          include: {
            attendee: true,
            ticketType: true,
          },
        },
        roomType: {
          include: {
            hotel: true,
          },
        },
      },
    });

    if (!accommodation) {
      return NextResponse.json({ error: "Accommodation not found" }, { status: 404 });
    }

    return NextResponse.json(accommodation);
  } catch (error) {
    console.error("Error fetching accommodation:", error);
    return NextResponse.json(
      { error: "Failed to fetch accommodation" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const { eventId, accommodationId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const existingAccommodation = await db.accommodation.findFirst({
      where: {
        id: accommodationId,
        eventId,
      },
      include: {
        roomType: true,
      },
    });

    if (!existingAccommodation) {
      return NextResponse.json({ error: "Accommodation not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = updateAccommodationSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;
    let totalPrice = existingAccommodation.totalPrice;
    let newRoomTypeId = existingAccommodation.roomTypeId;

    // Handle room type change
    if (data.roomTypeId && data.roomTypeId !== existingAccommodation.roomTypeId) {
      const newRoomType = await db.roomType.findFirst({
        where: {
          id: data.roomTypeId,
          isActive: true,
          hotel: {
            eventId,
            isActive: true,
          },
        },
      });

      if (!newRoomType) {
        return NextResponse.json({ error: "Room type not found or inactive" }, { status: 404 });
      }

      if (newRoomType.bookedRooms >= newRoomType.totalRooms) {
        return NextResponse.json({ error: "No rooms available for this room type" }, { status: 400 });
      }

      // Decrement old room type booked count
      await db.roomType.update({
        where: { id: existingAccommodation.roomTypeId },
        data: { bookedRooms: { decrement: 1 } },
      });

      // Increment new room type booked count
      await db.roomType.update({
        where: { id: data.roomTypeId },
        data: { bookedRooms: { increment: 1 } },
      });

      newRoomTypeId = data.roomTypeId;

      // Recalculate price
      const checkInDate = data.checkIn ? new Date(data.checkIn) : existingAccommodation.checkIn;
      const checkOutDate = data.checkOut ? new Date(data.checkOut) : existingAccommodation.checkOut;
      const nights = Math.ceil(
        (checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      totalPrice = Number(newRoomType.pricePerNight) * nights;
    } else if (data.checkIn || data.checkOut) {
      // Recalculate price for date changes
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

    // Handle cancellation - release room
    if (data.status === "CANCELLED" && existingAccommodation.status !== "CANCELLED") {
      await db.roomType.update({
        where: { id: existingAccommodation.roomTypeId },
        data: { bookedRooms: { decrement: 1 } },
      });
    } else if (data.status !== "CANCELLED" && existingAccommodation.status === "CANCELLED") {
      // Reactivating - book room again
      const roomType = await db.roomType.findFirst({
        where: { id: existingAccommodation.roomTypeId },
      });

      if (roomType && roomType.bookedRooms >= roomType.totalRooms) {
        return NextResponse.json({ error: "No rooms available" }, { status: 400 });
      }

      await db.roomType.update({
        where: { id: existingAccommodation.roomTypeId },
        data: { bookedRooms: { increment: 1 } },
      });
    }

    const accommodation = await db.accommodation.update({
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
        registration: {
          include: {
            attendee: true,
          },
        },
        roomType: {
          include: {
            hotel: true,
          },
        },
      },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "Accommodation",
        entityId: accommodation.id,
        changes: {
          before: existingAccommodation,
          after: accommodation,
        },
      },
    });

    return NextResponse.json(accommodation);
  } catch (error) {
    console.error("Error updating accommodation:", error);
    return NextResponse.json(
      { error: "Failed to update accommodation" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { eventId, accommodationId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const accommodation = await db.accommodation.findFirst({
      where: {
        id: accommodationId,
        eventId,
      },
    });

    if (!accommodation) {
      return NextResponse.json({ error: "Accommodation not found" }, { status: 404 });
    }

    // Release room if not already cancelled
    if (accommodation.status !== "CANCELLED") {
      await db.roomType.update({
        where: { id: accommodation.roomTypeId },
        data: { bookedRooms: { decrement: 1 } },
      });
    }

    await db.accommodation.delete({
      where: { id: accommodationId },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "Accommodation",
        entityId: accommodationId,
        changes: { deleted: accommodation },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting accommodation:", error);
    return NextResponse.json(
      { error: "Failed to delete accommodation" },
      { status: 500 }
    );
  }
}
