import { NextResponse } from "next/server";
import { z } from "zod";
import { AccommodationStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";
import {
  createAccommodation,
  type CreateAccommodationErrorCode,
} from "@/services/accommodation-service";

// HTTP status mapping for the service's domain error codes. Kept local to
// the REST caller — the service never knows about HTTP.
const HTTP_STATUS_FOR_ACCOMMODATION_ERROR: Record<CreateAccommodationErrorCode, number> = {
  MISSING_ASSIGNEE: 400,
  INVALID_DATES: 400,
  EVENT_NOT_FOUND: 404,
  REGISTRATION_NOT_FOUND: 404,
  SPEAKER_NOT_FOUND: 404,
  REGISTRATION_HAS_ACCOMMODATION: 400,
  SPEAKER_HAS_ACCOMMODATION: 400,
  ROOM_NOT_FOUND: 404,
  GUEST_COUNT_EXCEEDS_CAPACITY: 400,
  NO_ROOMS_AVAILABLE: 400,
  UNKNOWN: 500,
};

const accommodationStatusSchema = z.nativeEnum(AccommodationStatus);

const createAccommodationSchema = z.object({
  registrationId: z.string().min(1).optional(),
  speakerId: z.string().min(1).optional(),
  roomTypeId: z.string().min(1),
  checkIn: z.string().datetime(),
  checkOut: z.string().datetime(),
  guestCount: z.number().min(1).default(1),
  specialRequests: z.string().optional(),
}).refine((data) => data.registrationId || data.speakerId, {
  message: "Either registrationId or speakerId is required",
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
    const statusParam = searchParams.get("status");
    const parsedStatus = statusParam ? accommodationStatusSchema.safeParse(statusParam) : null;
    const status = parsedStatus?.success ? parsedStatus.data : undefined;
    const hotelId = searchParams.get("hotelId");

    // Parallelize event validation and accommodations fetch
    const [event, accommodations] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId!,
        },
        select: { id: true },
      }),
      db.accommodation.findMany({
        where: {
          eventId,
          ...(status && { status }),
          ...(hotelId && {
            roomType: {
              hotelId,
            },
          }),
        },
        include: {
          registration: {
            select: {
              attendee: {
                select: {
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
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
            select: {
              name: true,
              hotel: {
                select: { name: true },
              },
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

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = createAccommodationSchema.safeParse(body);

    if (!validated.success) {
      apiLogger.warn({ msg: "Accommodation create validation failed", eventId, errors: validated.error.flatten(), userId: session.user.id });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const {
      registrationId,
      speakerId,
      roomTypeId,
      checkIn,
      checkOut,
      guestCount,
      specialRequests,
    } = validated.data;

    const result = await createAccommodation({
      eventId,
      organizationId: session.user.organizationId!,
      userId: session.user.id,
      registrationId,
      speakerId,
      roomTypeId,
      checkIn: new Date(checkIn),
      checkOut: new Date(checkOut),
      guestCount,
      specialRequests,
      source: "rest",
      requestIp: getClientIp(req),
    });

    if (!result.ok) {
      const status = HTTP_STATUS_FOR_ACCOMMODATION_ERROR[result.code] ?? 500;
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.meta ?? {}) },
        { status },
      );
    }

    return NextResponse.json(result.accommodation, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating accommodation" });
    return NextResponse.json(
      { error: "Failed to create accommodation" },
      { status: 500 }
    );
  }
}
