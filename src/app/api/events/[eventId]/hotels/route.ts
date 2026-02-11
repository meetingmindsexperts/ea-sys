import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";

const createHotelSchema = z.object({
  name: z.string().min(1),
  address: z.string().optional(),
  description: z.string().optional(),
  contactEmail: z.string().email().optional().or(z.literal("")),
  contactPhone: z.string().optional(),
  stars: z.number().min(1).max(5).optional(),
  images: z.array(z.string().url()).optional(),
  isActive: z.boolean().default(true),
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

    // Parallelize event validation and hotels fetch
    const [event, hotels] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId!,
        },
        select: { id: true },
      }),
      db.hotel.findMany({
        where: { eventId },
        include: {
          roomTypes: {
            include: {
              _count: {
                select: { accommodations: true },
              },
            },
          },
          _count: {
            select: { roomTypes: true },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Add cache headers for better performance
    const response = NextResponse.json(hotels);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching hotels" });
    return NextResponse.json(
      { error: "Failed to fetch hotels" },
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

    const denied = denyReviewer(session);
    if (denied) return denied;

    // Use select for minimal data fetch
    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId!,
      },
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const validated = createHotelSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const {
      name,
      address,
      description,
      contactEmail,
      contactPhone,
      stars,
      images,
      isActive,
    } = validated.data;

    const hotel = await db.hotel.create({
      data: {
        eventId,
        name,
        address: address || null,
        description: description || null,
        contactEmail: contactEmail || null,
        contactPhone: contactPhone || null,
        stars: stars || null,
        images: images || [],
        isActive,
      },
      include: {
        _count: {
          select: { roomTypes: true },
        },
      },
    });

    // Log the action (non-blocking for better response time)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "Hotel",
        entityId: hotel.id,
        changes: JSON.parse(JSON.stringify({ hotel })),
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    return NextResponse.json(hotel, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating hotel" });
    return NextResponse.json(
      { error: "Failed to create hotel" },
      { status: 500 }
    );
  }
}
