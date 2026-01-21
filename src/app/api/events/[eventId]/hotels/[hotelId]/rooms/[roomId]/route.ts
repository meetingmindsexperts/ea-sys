import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

const updateRoomTypeSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  pricePerNight: z.number().min(0).optional(),
  currency: z.string().optional(),
  capacity: z.number().min(1).optional(),
  totalRooms: z.number().min(1).optional(),
  amenities: z.array(z.string()).optional(),
  images: z.array(z.string().url()).optional(),
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
        organizationId: session.user.organizationId,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const roomType = await db.roomType.findFirst({
      where: {
        id: roomId,
        hotelId,
      },
      include: {
        hotel: true,
        accommodations: {
          include: {
            registration: {
              include: {
                attendee: true,
              },
            },
          },
        },
        _count: {
          select: { accommodations: true },
        },
      },
    });

    if (!roomType) {
      return NextResponse.json({ error: "Room type not found" }, { status: 404 });
    }

    return NextResponse.json(roomType);
  } catch (error) {
    console.error("Error fetching room type:", error);
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

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const existingRoomType = await db.roomType.findFirst({
      where: {
        id: roomId,
        hotelId,
      },
    });

    if (!existingRoomType) {
      return NextResponse.json({ error: "Room type not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = updateRoomTypeSchema.safeParse(body);

    if (!validated.success) {
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
        },
      },
    });

    return NextResponse.json(roomType);
  } catch (error) {
    console.error("Error updating room type:", error);
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

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const roomType = await db.roomType.findFirst({
      where: {
        id: roomId,
        hotelId,
      },
      include: {
        _count: {
          select: { accommodations: true },
        },
      },
    });

    if (!roomType) {
      return NextResponse.json({ error: "Room type not found" }, { status: 404 });
    }

    // Don't allow deletion if there are bookings
    if (roomType._count.accommodations > 0) {
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
        changes: { deleted: roomType },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting room type:", error);
    return NextResponse.json(
      { error: "Failed to delete room type" },
      { status: 500 }
    );
  }
}
