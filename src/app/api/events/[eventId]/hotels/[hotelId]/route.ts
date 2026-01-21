import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

const updateHotelSchema = z.object({
  name: z.string().min(1).optional(),
  address: z.string().optional(),
  description: z.string().optional(),
  contactEmail: z.string().email().optional().or(z.literal("")),
  contactPhone: z.string().optional(),
  stars: z.number().min(1).max(5).nullable().optional(),
  images: z.array(z.string().url()).optional(),
  isActive: z.boolean().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; hotelId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { eventId, hotelId } = await params;
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

    const hotel = await db.hotel.findFirst({
      where: {
        id: hotelId,
        eventId,
      },
      include: {
        roomTypes: {
          include: {
            _count: {
              select: { accommodations: true },
            },
          },
        },
      },
    });

    if (!hotel) {
      return NextResponse.json({ error: "Hotel not found" }, { status: 404 });
    }

    return NextResponse.json(hotel);
  } catch (error) {
    console.error("Error fetching hotel:", error);
    return NextResponse.json(
      { error: "Failed to fetch hotel" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const { eventId, hotelId } = await params;
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

    const existingHotel = await db.hotel.findFirst({
      where: {
        id: hotelId,
        eventId,
      },
    });

    if (!existingHotel) {
      return NextResponse.json({ error: "Hotel not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = updateHotelSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    const hotel = await db.hotel.update({
      where: { id: hotelId },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.address !== undefined && { address: data.address || null }),
        ...(data.description !== undefined && { description: data.description || null }),
        ...(data.contactEmail !== undefined && { contactEmail: data.contactEmail || null }),
        ...(data.contactPhone !== undefined && { contactPhone: data.contactPhone || null }),
        ...(data.stars !== undefined && { stars: data.stars }),
        ...(data.images && { images: data.images }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
      include: {
        roomTypes: {
          include: {
            _count: {
              select: { accommodations: true },
            },
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
        entityType: "Hotel",
        entityId: hotel.id,
        changes: {
          before: existingHotel,
          after: hotel,
        },
      },
    });

    return NextResponse.json(hotel);
  } catch (error) {
    console.error("Error updating hotel:", error);
    return NextResponse.json(
      { error: "Failed to update hotel" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { eventId, hotelId } = await params;
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

    const hotel = await db.hotel.findFirst({
      where: {
        id: hotelId,
        eventId,
      },
      include: {
        roomTypes: {
          include: {
            _count: {
              select: { accommodations: true },
            },
          },
        },
      },
    });

    if (!hotel) {
      return NextResponse.json({ error: "Hotel not found" }, { status: 404 });
    }

    // Check if any room types have bookings
    const hasBookings = hotel.roomTypes.some((rt) => rt._count.accommodations > 0);
    if (hasBookings) {
      return NextResponse.json(
        { error: "Cannot delete hotel with existing bookings" },
        { status: 400 }
      );
    }

    await db.hotel.delete({
      where: { id: hotelId },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "Hotel",
        entityId: hotelId,
        changes: { deleted: hotel },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting hotel:", error);
    return NextResponse.json(
      { error: "Failed to delete hotel" },
      { status: 500 }
    );
  }
}
