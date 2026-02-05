import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

const createAccommodationSchema = z.object({
  registrationId: z.string().min(1),
  roomTypeId: z.string().min(1),
  checkIn: z.string().datetime(),
  checkOut: z.string().datetime(),
  guestCount: z.number().min(1).default(1),
  specialRequests: z.string().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    // Parallelize params and auth for faster response
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const hotelId = searchParams.get("hotelId");

    // Parallelize event validation and accommodations fetch
    const [event, accommodations] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId,
        },
        select: { id: true },
      }),
      db.accommodation.findMany({
        where: {
          eventId,
          ...(status && { status: status as any }),
          ...(hotelId && {
            roomType: {
              hotelId,
            },
          }),
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
        orderBy: { checkIn: "asc" },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Add cache headers for better performance
    const response = NextResponse.json(accommodations);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching accommodations" });
    return NextResponse.json(
      { error: "Failed to fetch accommodations" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    // Parallelize params, auth, and body parsing
    const [{ eventId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validated = createAccommodationSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const {
      registrationId,
      roomTypeId,
      checkIn,
      checkOut,
      guestCount,
      specialRequests,
    } = validated.data;

    // Parallelize event, registration, and room type validation
    const [event, registration, roomType] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId,
        },
        select: { id: true },
      }),
      db.registration.findFirst({
        where: {
          id: registrationId,
          eventId,
        },
        include: {
          accommodation: true,
        },
      }),
      db.roomType.findFirst({
        where: {
          id: roomTypeId,
          isActive: true,
          hotel: {
            eventId,
            isActive: true,
          },
        },
        include: {
          hotel: true,
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    // Check if registration already has accommodation
    if (registration.accommodation) {
      return NextResponse.json(
        { error: "Registration already has accommodation assigned" },
        { status: 400 }
      );
    }

    if (!roomType) {
      return NextResponse.json({ error: "Room type not found or inactive" }, { status: 404 });
    }

    if (roomType.bookedRooms >= roomType.totalRooms) {
      return NextResponse.json({ error: "No rooms available" }, { status: 400 });
    }

    // Validate guest count
    if (guestCount > roomType.capacity) {
      return NextResponse.json(
        { error: `Guest count exceeds room capacity (${roomType.capacity})` },
        { status: 400 }
      );
    }

    // Calculate total price
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    const nights = Math.ceil(
      (checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (nights <= 0) {
      return NextResponse.json(
        { error: "Check-out must be after check-in" },
        { status: 400 }
      );
    }

    const totalPrice = Number(roomType.pricePerNight) * nights;

    const accommodation = await db.accommodation.create({
      data: {
        eventId,
        registrationId,
        roomTypeId,
        checkIn: checkInDate,
        checkOut: checkOutDate,
        guestCount,
        specialRequests: specialRequests || null,
        totalPrice,
        currency: roomType.currency,
        status: "PENDING",
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

    // Update booked rooms count
    await db.roomType.update({
      where: { id: roomTypeId },
      data: { bookedRooms: { increment: 1 } },
    });

    // Log the action (non-blocking for better response time)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "Accommodation",
        entityId: accommodation.id,
        changes: JSON.parse(JSON.stringify({ accommodation })),
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    return NextResponse.json(accommodation, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating accommodation" });
    return NextResponse.json(
      { error: "Failed to create accommodation" },
      { status: 500 }
    );
  }
}
