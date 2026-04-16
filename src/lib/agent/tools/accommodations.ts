import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { ToolExecutor } from "./_shared";

const ACCOMMODATION_STATUSES = new Set(["PENDING", "CONFIRMED", "CANCELLED", "CHECKED_IN", "CHECKED_OUT"]);

const listHotels: ToolExecutor = async (_input, ctx) => {
  try {
    const hotels = await db.hotel.findMany({
      where: { eventId: ctx.eventId },
      select: {
        id: true, name: true, address: true, stars: true, contactEmail: true, isActive: true,
        _count: { select: { roomTypes: true } },
      },
      orderBy: { name: "asc" },
    });
    return { hotels, total: hotels.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_hotels failed");
    return { error: "Failed to fetch hotels" };
  }
};

const createHotel: ToolExecutor = async (input, ctx) => {
  try {
    const name = String(input.name ?? "").trim();
    if (!name) return { error: "name is required" };

    const existing = await db.hotel.findFirst({
      where: { eventId: ctx.eventId, name: { equals: name, mode: "insensitive" } },
    });
    if (existing) return { alreadyExists: true, hotel: existing };

    const hotel = await db.hotel.create({
      data: {
        eventId: ctx.eventId,
        name,
        address: input.address ? String(input.address) : null,
        stars: input.stars ? Number(input.stars) : null,
        contactEmail: input.contactEmail ? String(input.contactEmail) : null,
        contactPhone: input.contactPhone ? String(input.contactPhone) : null,
      },
    });
    return { hotel };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_hotel failed");
    return { error: "Failed to create hotel" };
  }
};

const listAccommodations: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 200);
    const statusValue = input.status ? String(input.status) : undefined;
    if (statusValue && !ACCOMMODATION_STATUSES.has(statusValue)) {
      return { error: `Invalid status. Must be one of: ${[...ACCOMMODATION_STATUSES].join(", ")}` };
    }
    const accommodations = await db.accommodation.findMany({
      where: {
        eventId: ctx.eventId,
        ...(statusValue ? { status: statusValue as never } : {}),
      },
      select: {
        id: true, checkIn: true, checkOut: true, guestCount: true, status: true, totalPrice: true, currency: true,
        registration: { select: { attendee: { select: { firstName: true, lastName: true, email: true } } } },
        roomType: { select: { name: true, hotel: { select: { name: true } } } },
      },
      take: limit,
      orderBy: { checkIn: "asc" },
    });
    return { accommodations, total: accommodations.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_accommodations failed");
    return { error: "Failed to fetch accommodations" };
  }
};

// ─── Media Executor ───────────────────────────────────────────────────────────

const listRoomTypes: ToolExecutor = async (input, ctx) => {
  try {
    const hotelId = input.hotelId ? String(input.hotelId) : undefined;

    const roomTypes = await db.roomType.findMany({
      where: {
        hotel: {
          eventId: ctx.eventId,
          ...(hotelId ? { id: hotelId } : {}),
          isActive: true,
        },
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        description: true,
        capacity: true,
        pricePerNight: true,
        currency: true,
        totalRooms: true,
        bookedRooms: true,
        hotel: { select: { id: true, name: true, stars: true } },
      },
      orderBy: { pricePerNight: "asc" },
    });

    return {
      roomTypes: roomTypes.map((r) => ({
        ...r,
        pricePerNight: Number(r.pricePerNight),
        available: r.totalRooms - r.bookedRooms,
      })),
      total: roomTypes.length,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_room_types failed");
    return { error: "Failed to list room types" };
  }
};

const createAccommodation: ToolExecutor = async (input, ctx) => {
  try {
    const registrationId = input.registrationId ? String(input.registrationId).trim() : undefined;
    const speakerId = input.speakerId ? String(input.speakerId).trim() : undefined;
    const roomTypeId = String(input.roomTypeId ?? "").trim();
    const checkInStr = String(input.checkIn ?? "").trim();
    const checkOutStr = String(input.checkOut ?? "").trim();

    if (!registrationId && !speakerId) {
      return { error: "Either registrationId or speakerId is required" };
    }
    if (!roomTypeId) return { error: "roomTypeId is required" };
    if (!checkInStr || !checkOutStr) return { error: "checkIn and checkOut are required (ISO 8601)" };

    const checkInDate = new Date(checkInStr);
    const checkOutDate = new Date(checkOutStr);
    if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
      return { error: "checkIn and checkOut must be valid ISO 8601 datetime strings" };
    }
    const nights = Math.ceil((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24));
    if (nights <= 0) return { error: "checkOut must be after checkIn" };

    const guestCount = Math.max(1, Number(input.guestCount ?? 1));

    // Validate event access + entities in parallel
    const [event, registration, speaker, roomType] = await Promise.all([
      db.event.findFirst({
        where: { id: ctx.eventId, organizationId: ctx.organizationId },
        select: { id: true },
      }),
      registrationId
        ? db.registration.findFirst({
            where: { id: registrationId, eventId: ctx.eventId },
            select: { id: true, accommodation: { select: { id: true } } },
          })
        : null,
      speakerId
        ? db.speaker.findFirst({
            where: { id: speakerId, eventId: ctx.eventId },
            select: { id: true, accommodation: { select: { id: true } } },
          })
        : null,
      db.roomType.findFirst({
        where: {
          id: roomTypeId,
          isActive: true,
          hotel: { eventId: ctx.eventId, isActive: true },
        },
        select: {
          id: true,
          capacity: true,
          pricePerNight: true,
          currency: true,
          bookedRooms: true,
          totalRooms: true,
        },
      }),
    ]);

    if (!event) return { error: "Event not found or access denied" };
    if (registrationId && !registration) return { error: `Registration ${registrationId} not found in this event` };
    if (speakerId && !speaker) return { error: `Speaker ${speakerId} not found in this event` };
    if (registration?.accommodation) {
      return {
        error: "Registration already has accommodation assigned",
        existingAccommodationId: registration.accommodation.id,
        suggestion: "Use update_accommodation_status to modify, or remove existing first",
      };
    }
    if (speaker?.accommodation) {
      return {
        error: "Speaker already has accommodation assigned",
        existingAccommodationId: speaker.accommodation.id,
        suggestion: "Use update_accommodation_status to modify, or remove existing first",
      };
    }
    if (!roomType) return { error: "Room type not found or inactive" };
    if (guestCount > roomType.capacity) {
      return { error: `guestCount (${guestCount}) exceeds room capacity (${roomType.capacity})` };
    }

    const totalPrice = Number(roomType.pricePerNight) * nights;

    // Atomic: overbooking guard inside tx + counter increment
    const accommodation = await db.$transaction(async (tx) => {
      const fresh = await tx.roomType.findUnique({
        where: { id: roomTypeId },
        select: { bookedRooms: true, totalRooms: true },
      });
      if (!fresh || fresh.bookedRooms >= fresh.totalRooms) {
        throw new Error("NO_ROOMS_AVAILABLE");
      }

      const created = await tx.accommodation.create({
        data: {
          eventId: ctx.eventId,
          ...(registrationId && { registrationId }),
          ...(speakerId && { speakerId }),
          roomTypeId,
          checkIn: checkInDate,
          checkOut: checkOutDate,
          guestCount,
          specialRequests: input.specialRequests ? String(input.specialRequests).slice(0, 1000) : null,
          totalPrice,
          currency: roomType.currency,
          status: "PENDING",
        },
        select: {
          id: true,
          status: true,
          checkIn: true,
          checkOut: true,
          guestCount: true,
          totalPrice: true,
          currency: true,
          roomType: { select: { name: true, hotel: { select: { name: true } } } },
        },
      });

      await tx.roomType.update({
        where: { id: roomTypeId },
        data: { bookedRooms: { increment: 1 } },
      });

      return created;
    });

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "CREATE",
        entityType: "Accommodation",
        entityId: accommodation.id,
        changes: {
          source: "mcp",
          registrationId: registrationId ?? null,
          speakerId: speakerId ?? null,
          roomTypeId,
          nights,
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:create_accommodation audit-log-failed"));

    return { success: true, accommodation: { ...accommodation, totalPrice: Number(accommodation.totalPrice), nights } };
  } catch (err) {
    if (err instanceof Error && err.message === "NO_ROOMS_AVAILABLE") {
      return { error: "No rooms available for this room type" };
    }
    apiLogger.error({ err }, "agent:create_accommodation failed");
    return { error: err instanceof Error ? err.message : "Failed to create accommodation" };
  }
};

const ACCOMMODATION_STATUSES_SET = new Set(["PENDING", "CONFIRMED", "CANCELLED", "CHECKED_IN", "CHECKED_OUT"]);

const updateAccommodationStatus: ToolExecutor = async (input, ctx) => {
  try {
    const accommodationId = String(input.accommodationId ?? "").trim();
    const status = String(input.status ?? "").trim();
    if (!accommodationId) return { error: "accommodationId is required" };
    if (!ACCOMMODATION_STATUSES_SET.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...ACCOMMODATION_STATUSES_SET].join(", ")}` };
    }

    const existing = await db.accommodation.findFirst({
      where: { id: accommodationId, event: { organizationId: ctx.organizationId } },
      select: { id: true, eventId: true, status: true, roomTypeId: true },
    });
    if (!existing) return { error: `Accommodation ${accommodationId} not found or access denied` };

    if (existing.status === status) {
      return { success: true, accommodation: existing, message: `Already in status ${status}` };
    }

    // Room counter adjustments around CANCELLED transitions (matches REST route logic)
    const wasActive = existing.status !== "CANCELLED";
    const willBeActive = status !== "CANCELLED";

    const updated = await db.$transaction(async (tx) => {
      if (wasActive && !willBeActive) {
        // active → CANCELLED: release the room
        await tx.roomType.update({
          where: { id: existing.roomTypeId },
          data: { bookedRooms: { decrement: 1 } },
        });
      } else if (!wasActive && willBeActive) {
        // CANCELLED → active: re-book the room, but guard against overbooking
        const fresh = await tx.roomType.findUnique({
          where: { id: existing.roomTypeId },
          select: { bookedRooms: true, totalRooms: true },
        });
        if (!fresh || fresh.bookedRooms >= fresh.totalRooms) {
          throw new Error("NO_ROOMS_AVAILABLE");
        }
        await tx.roomType.update({
          where: { id: existing.roomTypeId },
          data: { bookedRooms: { increment: 1 } },
        });
      }

      return tx.accommodation.update({
        where: { id: accommodationId },
        data: { status: status as never },
        select: {
          id: true,
          status: true,
          checkIn: true,
          checkOut: true,
          roomType: { select: { name: true, hotel: { select: { name: true } } } },
        },
      });
    });

    db.auditLog.create({
      data: {
        eventId: existing.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Accommodation",
        entityId: accommodationId,
        changes: { source: "mcp", before: existing.status, after: status },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_accommodation_status audit-log-failed"));

    return { success: true, accommodation: updated };
  } catch (err) {
    if (err instanceof Error && err.message === "NO_ROOMS_AVAILABLE") {
      return { error: "Cannot reinstate: no rooms available in that room type" };
    }
    apiLogger.error({ err }, "agent:update_accommodation_status failed");
    return { error: err instanceof Error ? err.message : "Failed to update accommodation status" };
  }
};

// ─── A4: Invoice CREATE / SEND flow ───────────────────────────────────────────

export const ACCOMMODATION_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_hotels",
    description: "List hotels configured for this event.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "create_hotel",
    description: "Add a hotel for this event.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Hotel name" },
        address: { type: "string" },
        stars: { type: "number", description: "Star rating (1-5)" },
        contactEmail: { type: "string" },
        contactPhone: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_accommodations",
    description: "List room bookings for this event with guest details.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["PENDING", "CONFIRMED", "CANCELLED", "CHECKED_IN", "CHECKED_OUT"] },
        limit: { type: "number", description: "Max results (default 50, max 200)" },
      },
      required: [],
    },
  },
];

export const ACCOMMODATION_EXECUTORS: Record<string, ToolExecutor> = {
  list_hotels: listHotels,
  create_hotel: createHotel,
  list_accommodations: listAccommodations,
  list_room_types: listRoomTypes,
  create_accommodation: createAccommodation,
  update_accommodation_status: updateAccommodationStatus,
};
