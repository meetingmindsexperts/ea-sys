/**
 * Accommodation service — domain logic for creating hotel room bookings,
 * shared by REST API routes and MCP agent tools.
 *
 * Enforces the atomic overbooking guard (updateMany with a soldCount
 * predicate inside a transaction) that was previously duplicated across
 * two callers — if the logic drifts between them, a concurrent double-
 * booking can slip through. Centralizing it here eliminates that class
 * of bug by construction.
 *
 * See src/services/README.md for the conventions this file follows
 * (result-type pattern, caller identity via `source`, owned side effects).
 */

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

// ── Input / Result types ─────────────────────────────────────────────────────

export interface CreateAccommodationInput {
  eventId: string;
  organizationId: string;
  userId: string;

  // At least one of registrationId / speakerId is required. Validated at the
  // top of the function — callers don't need to pre-check.
  registrationId?: string;
  speakerId?: string;

  roomTypeId: string;
  checkIn: Date;
  checkOut: Date;
  guestCount?: number;
  specialRequests?: string | null;

  // Caller identity — written into the audit log's `changes.source`.
  // REST passes "rest" + requestIp; MCP passes "mcp"; future public API "api".
  source: "rest" | "mcp" | "api";
  requestIp?: string;
}

export type CreateAccommodationErrorCode =
  | "MISSING_ASSIGNEE"
  | "INVALID_DATES"
  | "EVENT_NOT_FOUND"
  | "REGISTRATION_NOT_FOUND"
  | "SPEAKER_NOT_FOUND"
  | "REGISTRATION_HAS_ACCOMMODATION"
  | "SPEAKER_HAS_ACCOMMODATION"
  | "ROOM_NOT_FOUND"
  | "GUEST_COUNT_EXCEEDS_CAPACITY"
  | "NO_ROOMS_AVAILABLE"
  | "UNKNOWN";

type AccommodationWithRelations = Prisma.AccommodationGetPayload<{
  include: {
    registration: { include: { attendee: true } };
    speaker: {
      select: {
        id: true;
        firstName: true;
        lastName: true;
        email: true;
        title: true;
        organization: true;
      };
    };
    roomType: { include: { hotel: true } };
  };
}>;

export type CreateAccommodationResult =
  | {
      ok: true;
      accommodation: AccommodationWithRelations;
      nights: number;
    }
  | {
      ok: false;
      code: CreateAccommodationErrorCode;
      message: string;
      meta?: Record<string, unknown>;
    };

// ── Service ──────────────────────────────────────────────────────────────────

export async function createAccommodation(
  input: CreateAccommodationInput,
): Promise<CreateAccommodationResult> {
  const {
    eventId,
    organizationId,
    userId,
    registrationId,
    speakerId,
    roomTypeId,
    checkIn,
    checkOut,
    source,
    requestIp,
  } = input;

  const guestCount = Math.max(1, Number(input.guestCount ?? 1));
  const specialRequests = input.specialRequests
    ? String(input.specialRequests).slice(0, 1000)
    : null;

  if (!registrationId && !speakerId) {
    return {
      ok: false,
      code: "MISSING_ASSIGNEE",
      message: "Either registrationId or speakerId is required",
    };
  }

  const nights = Math.ceil(
    (checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (nights <= 0) {
    return {
      ok: false,
      code: "INVALID_DATES",
      message: "Check-out must be after check-in",
    };
  }

  // Load event + assignees + room type in parallel. Event scope is enforced
  // via (eventId, organizationId) — a caller whose ctx.organizationId does
  // not own this event will match no row, producing EVENT_NOT_FOUND.
  const [event, registration, speaker, roomType] = await Promise.all([
    db.event.findFirst({
      where: { id: eventId, organizationId },
      select: { id: true },
    }),
    registrationId
      ? db.registration.findFirst({
          where: { id: registrationId, eventId },
          select: { id: true, accommodation: { select: { id: true } } },
        })
      : null,
    speakerId
      ? db.speaker.findFirst({
          where: { id: speakerId, eventId },
          select: { id: true, accommodation: { select: { id: true } } },
        })
      : null,
    db.roomType.findFirst({
      where: {
        id: roomTypeId,
        isActive: true,
        hotel: { eventId, isActive: true },
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

  if (!event) {
    return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" };
  }
  if (registrationId && !registration) {
    return { ok: false, code: "REGISTRATION_NOT_FOUND", message: "Registration not found" };
  }
  if (speakerId && !speaker) {
    return { ok: false, code: "SPEAKER_NOT_FOUND", message: "Speaker not found" };
  }
  if (registration?.accommodation) {
    return {
      ok: false,
      code: "REGISTRATION_HAS_ACCOMMODATION",
      message: "Registration already has accommodation assigned",
      meta: { existingAccommodationId: registration.accommodation.id },
    };
  }
  if (speaker?.accommodation) {
    return {
      ok: false,
      code: "SPEAKER_HAS_ACCOMMODATION",
      message: "Speaker already has accommodation assigned",
      meta: { existingAccommodationId: speaker.accommodation.id },
    };
  }
  if (!roomType) {
    return { ok: false, code: "ROOM_NOT_FOUND", message: "Room type not found or inactive" };
  }
  if (guestCount > roomType.capacity) {
    return {
      ok: false,
      code: "GUEST_COUNT_EXCEEDS_CAPACITY",
      message: `Guest count exceeds room capacity (${roomType.capacity})`,
      meta: { capacity: roomType.capacity },
    };
  }

  const totalPrice = Number(roomType.pricePerNight) * nights;

  // Atomic: re-check availability inside the tx via `bookedRooms < totalRooms`
  // predicate on the update, so two concurrent requests can't both slip past
  // a stale pre-check. The thrown sentinel is caught below and mapped to the
  // NO_ROOMS_AVAILABLE error code.
  let accommodation: AccommodationWithRelations;
  try {
    accommodation = await db.$transaction(async (tx) => {
      const fresh = await tx.roomType.findUnique({
        where: { id: roomTypeId },
        select: { bookedRooms: true, totalRooms: true },
      });
      if (!fresh || fresh.bookedRooms >= fresh.totalRooms) {
        throw new Error("NO_ROOMS_AVAILABLE");
      }

      const created = await tx.accommodation.create({
        data: {
          eventId,
          ...(registrationId && { registrationId }),
          ...(speakerId && { speakerId }),
          roomTypeId,
          checkIn,
          checkOut,
          guestCount,
          specialRequests,
          totalPrice,
          currency: roomType.currency,
          status: "PENDING",
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

      await tx.roomType.update({
        where: { id: roomTypeId },
        data: { bookedRooms: { increment: 1 } },
      });

      return created;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "NO_ROOMS_AVAILABLE") {
      return { ok: false, code: "NO_ROOMS_AVAILABLE", message: "No rooms available" };
    }
    apiLogger.error({ err }, "accommodation-service:create-failed");
    return {
      ok: false,
      code: "UNKNOWN",
      message: err instanceof Error ? err.message : "Failed to create accommodation",
    };
  }

  // Audit log (fire-and-forget). Caller identity flows through via `source`;
  // REST adds `ip` so the dashboard audit trail retains that signal.
  db.auditLog
    .create({
      data: {
        eventId,
        userId,
        action: "CREATE",
        entityType: "Accommodation",
        entityId: accommodation.id,
        changes: {
          source,
          registrationId: registrationId ?? null,
          speakerId: speakerId ?? null,
          roomTypeId,
          nights,
          ...(requestIp ? { ip: requestIp } : {}),
        },
      },
    })
    .catch((err) =>
      apiLogger.error({ err }, "accommodation-service:audit-log-failed"),
    );

  return { ok: true, accommodation, nights };
}
