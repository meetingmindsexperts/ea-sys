import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeTag } from "@/lib/utils";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";
import { deletePhoto } from "@/lib/storage";
import { refreshEventStats } from "@/lib/event-stats";
import { releaseRoomForDeletedPerson } from "@/lib/accommodation-rooms";
import { optimisticLockField } from "@/lib/optimistic-lock";
import { updateSpeaker, type UpdateSpeakerErrorCode } from "@/services/speaker-service";

/** Service error code → HTTP status. The service is transport-agnostic; this
 *  is the route's half of the contract. */
const HTTP_STATUS_FOR_UPDATE_SPEAKER: Record<UpdateSpeakerErrorCode, number> = {
  SPEAKER_NOT_FOUND: 404,
  NO_FIELDS: 400,
  STALE_WRITE: 409,
  UNKNOWN: 500,
};

// NOTE: `email` is intentionally NOT in this schema. Email is immutable
// at the general-purpose update path — use the dedicated
// `PATCH /api/events/[eventId]/speakers/[speakerId]/email` route instead,
// which performs the collision check + User.email cascade + Contact
// re-sync + audit log atomically. A plain field-level edit here would
// silently split identity across Speaker / User / Contact (the organizer-
// reported bug that motivated this lockdown).
const updateSpeakerSchema = z.object({
  ...optimisticLockField,
  title: titleEnum.optional().nullable(),
  role: attendeeRoleEnum.optional().nullable(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  // Secondary inbox auto-CC'd on every outgoing speaker email. Empty
  // string clears the column (admins legitimately need to remove a
  // typo'd value); same convention as the registration sheet.
  additionalEmail: z.string().email().max(255).optional().nullable().or(z.literal("")),
  bio: z.string().max(10000).optional(),
  organization: z.string().max(255).optional(),
  jobTitle: z.string().max(255).optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(500).optional().or(z.literal("")),
  photo: z.string().max(500).optional().nullable().or(z.literal("")),
  city: z.string().max(255).optional(),
  country: z.string().max(255).optional(),
  specialty: z.string().max(255).optional(),
  registrationType: z.string().max(255).optional(),
  tags: z.array(z.string().max(100).transform(normalizeTag)).optional(),
  socialLinks: z.object({
    twitter: z.string().max(500).optional(),
    linkedin: z.string().max(500).optional(),
    github: z.string().max(500).optional(),
  }).optional(),
  status: z.enum(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]).optional(),
  // Operator's answer to the decline-cascade prompt: when the status moves
  // INTO DECLINED/CANCELLED and the speaker has an auto-minted companion
  // registration, `true` cancels it too (revoking badge + entry barcode).
  // Ignored on any other write. See speaker-service.cascadeSpeakerDecline.
  cancelCompanionRegistration: z.boolean().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; speakerId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, speakerId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [event, speaker] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      }),
      db.speaker.findFirst({
        where: {
          id: speakerId,
          eventId,
        },
        include: {
          sessions: {
            include: {
              session: {
                include: {
                  track: true,
                },
              },
            },
          },
          topicSpeakers: {
            include: {
              topic: {
                include: {
                  session: {
                    select: { id: true, name: true, startTime: true },
                  },
                },
              },
            },
          },
          abstracts: {
            include: {
              track: true,
            },
          },
          // The speaker's "attendee facet" — the linked companion (or
          // email-matched real) registration that backs their badge / entry
          // barcode / DTCM / check-in / survey. Surfaced on the speaker detail
          // page so an organizer can see the registration id + status without
          // hunting the registrations list.
          sourceRegistration: {
            select: {
              id: true,
              serialId: true,
              status: true,
              paymentStatus: true,
              attendanceMode: true,
              badgeType: true,
              qrCode: true,
              checkedInAt: true,
              surveyCompletedAt: true,
              createdSource: true,
              ticketType: { select: { name: true, isFaculty: true } },
              attendee: { select: { email: true } },
            },
          },
          _count: {
            select: {
              sessions: true,
              abstracts: true,
            },
          },
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!speaker) {
      return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
    }

    return NextResponse.json(speaker);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching speaker" });
    return NextResponse.json(
      { error: "Failed to fetch speaker" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, speakerId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    // AUTHORIZATION stays here (the service takes `organizationId` on trust and
    // binds the speaker to {id, eventId} — it does not re-check that the event
    // belongs to the caller's org). 404, not 403, to avoid existence leaks.
    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId!,
      },
      select: { id: true },
    });

    if (!event) {
      apiLogger.warn({ msg: "speaker:update-event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // The speaker's own existence check now lives in the service
    // (SPEAKER_NOT_FOUND → 404 below), so it isn't duplicated here.
    const body = await req.json();

    // Email is immutable via the general-purpose update path. Return a
    // clear error code rather than silently stripping the field so clients
    // know to route through the dedicated email-change endpoint.
    if (body && typeof body === "object" && "email" in body) {
      return NextResponse.json(
        {
          error: "Email cannot be changed via this endpoint. Use PATCH /api/events/[eventId]/speakers/[speakerId]/email instead — it performs the collision check + User.email cascade + Contact re-sync atomically.",
          code: "EMAIL_IMMUTABLE",
        },
        { status: 400 }
      );
    }

    const validated = updateSpeakerSchema.safeParse(body);

    if (!validated.success) {
      apiLogger.warn({ msg: "Speaker update validation failed", speakerId, errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    // Everything below the boundary — the optimistic-locked write, the tag
    // mirror onto the registration facet, the decline cascade, the FULL contact
    // sync, the audit row and the stats refresh — is owned by the service, so
    // the MCP `update_speaker` path cannot drift from it again (contacts review
    // H4). The route keeps only what is HTTP's: auth, denyReviewer, the
    // EMAIL_IMMUTABLE guard, Zod, and the status mapping below.
    const result = await updateSpeaker({
      speakerId,
      eventId,
      organizationId: session.user.organizationId!,
      fields: {
        title: data.title,
        role: data.role,
        firstName: data.firstName,
        lastName: data.lastName,
        additionalEmail: data.additionalEmail,
        bio: data.bio,
        organization: data.organization,
        jobTitle: data.jobTitle,
        phone: data.phone,
        website: data.website,
        photo: data.photo,
        city: data.city,
        country: data.country,
        specialty: data.specialty,
        registrationType: data.registrationType,
        tags: data.tags,
        socialLinks: data.socialLinks,
        status: data.status,
      },
      expectedUpdatedAt: data.expectedUpdatedAt,
      cancelCompanionRegistration: data.cancelCompanionRegistration === true,
      source: "rest",
      actorUserId: session.user.id,
      requestIp: getClientIp(req),
    });

    if (!result.ok) {
      const status = HTTP_STATUS_FOR_UPDATE_SPEAKER[result.code];
      apiLogger.warn({
        msg: "speaker:update-rejected",
        code: result.code,
        speakerId,
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status },
      );
    }

    const { speaker, companionCascade } = result;

    // `companionCascade` tells the UI what happened to the companion
    // registration on a decline (cancelled / kept / real-registration / …).
    return NextResponse.json(companionCascade ? { ...speaker, companionCascade } : speaker);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating speaker" });
    return NextResponse.json(
      { error: "Failed to update speaker" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, speakerId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, speaker] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId!,
        },
        select: { id: true },
      }),
      db.speaker.findFirst({
        where: {
          id: speakerId,
          eventId,
        },
        include: {
          _count: {
            select: {
              abstracts: { where: { status: { not: "DRAFT" } } },
            },
          },
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!speaker) {
      return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
    }

    // Prevent deletion if speaker has non-DRAFT abstracts (reviewed, accepted, etc.)
    if (speaker._count.abstracts > 0) {
      return NextResponse.json(
        { error: "Cannot delete speaker with submitted or reviewed abstracts. Remove or reassign their abstracts first." },
        { status: 400 }
      );
    }

    // H4 (accommodation review): Accommodation cascade-deletes from Speaker, and
    // a DB cascade fires no application code — the booking row would vanish
    // while RoomType.bookedRooms kept counting it forever. Release the room in
    // the same transaction as the delete. No-op when the speaker has no booking
    // (or it's already cancelled).
    await db.$transaction(async (tx) => {
      await releaseRoomForDeletedPerson(tx, { speakerId });
      await tx.speaker.delete({ where: { id: speakerId } });
    });

    // Companion cleanup (speaker-as-attendee Fix A) — if this speaker had an
    // auto-created Faculty companion registration, delete it too so it doesn't
    // dangle as a badge/barcode with no speaker. ONLY touch SPEAKER_COMPANION
    // rows — a real, email-linked registration is the person's own and must
    // survive. Delete the companion's attendee only when no other registration
    // shares it (mirrors the registration DELETE sibling guard).
    if (speaker.sourceRegistrationId) {
      try {
        const companion = await db.registration.findFirst({
          where: { id: speaker.sourceRegistrationId, createdSource: "SPEAKER_COMPANION" },
          select: { id: true, attendeeId: true },
        });
        if (companion) {
          await db.$transaction(async (tx) => {
            // Same cascade hazard as above — the companion registration can hold
            // its own booking (faculty are given rooms too).
            await releaseRoomForDeletedPerson(tx, { registrationId: companion.id });
            await tx.registration.delete({ where: { id: companion.id } });
            const remaining = await tx.registration.count({ where: { attendeeId: companion.attendeeId } });
            if (remaining === 0) {
              await tx.attendee.delete({ where: { id: companion.attendeeId } });
            }
          });
          apiLogger.info({ msg: "speaker-companion:deleted-with-speaker", eventId, speakerId, registrationId: companion.id });
        }
      } catch (err) {
        apiLogger.error({ err, msg: "speaker-companion:delete-failed", eventId, speakerId });
      }
    }

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    // Clean up photo file if present
    if (speaker.photo) {
      deletePhoto(speaker.photo).catch((err) =>
        apiLogger.warn({ msg: "Failed to delete speaker photo", photo: speaker.photo, err })
      );
    }

    // Log the action. Fire-and-forget (M13): the delete is already committed —
    // a transient audit-insert blip (P2024 pool class) must not turn a
    // completed delete into a user-facing 500.
    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "DELETE",
          entityType: "Speaker",
          entityId: speakerId,
          changes: { deleted: speaker, ip: getClientIp(req) },
        },
      })
      .catch((err) =>
        apiLogger.error({ err, eventId, speakerId }, "speaker-delete:audit-write-failed"),
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting speaker" });
    return NextResponse.json(
      { error: "Failed to delete speaker" },
      { status: 500 }
    );
  }
}
