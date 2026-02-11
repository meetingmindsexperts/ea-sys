import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";

const createRoomTypeSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  pricePerNight: z.number().min(0),
  currency: z.string().default("USD"),
  capacity: z.number().min(1).default(2),
  totalRooms: z.number().min(1),
  amenities: z.array(z.string()).optional(),
  images: z.array(z.string().url()).optional(),
  isActive: z.boolean().default(true),
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
        organizationId: session.user.organizationId!,
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
    });

    if (!hotel) {
      return NextResponse.json({ error: "Hotel not found" }, { status: 404 });
    }

    const roomTypes = await db.roomType.findMany({
      where: { hotelId },
      include: {
        _count: {
          select: { accommodations: true },
        },
      },
      orderBy: { pricePerNight: "asc" },
    });

    return NextResponse.json(roomTypes);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching room types" });
    return NextResponse.json(
      { error: "Failed to fetch room types" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { eventId, hotelId } = await params;
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
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const hotel = await db.hotel.findFirst({
      where: {
        id: hotelId,
        eventId,
      },
    });

    if (!hotel) {
      return NextResponse.json({ error: "Hotel not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = createRoomTypeSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const {
      name,
      description,
      pricePerNight,
      currency,
      capacity,
      totalRooms,
      amenities,
      images,
      isActive,
    } = validated.data;

    const roomType = await db.roomType.create({
      data: {
        hotelId,
        name,
        description: description || null,
        pricePerNight,
        currency,
        capacity,
        totalRooms,
        amenities: amenities || [],
        images: images || [],
        isActive,
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
        action: "CREATE",
        entityType: "RoomType",
        entityId: roomType.id,
        changes: { roomType, hotelId },
      },
    });

    return NextResponse.json(roomType, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating room type" });
    return NextResponse.json(
      { error: "Failed to create room type" },
      { status: 500 }
    );
  }
}
