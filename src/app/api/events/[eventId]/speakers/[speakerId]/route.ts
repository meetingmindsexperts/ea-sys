import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeTag } from "@/lib/utils";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { titleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";
import { deletePhoto } from "@/lib/storage";
import { refreshEventStats } from "@/lib/event-stats";

// NOTE: `email` is intentionally NOT in this schema. Email is immutable
// at the general-purpose update path — use the dedicated
// `PATCH /api/events/[eventId]/speakers/[speakerId]/email` route instead,
// which performs the collision check + User.email cascade + Contact
// re-sync + audit log atomically. A plain field-level edit here would
// silently split identity across Speaker / User / Contact (the organizer-
// reported bug that motivated this lockdown).
const updateSpeakerSchema = z.object({
  title: titleEnum.optional().nullable(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
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

    const [event, existingSpeaker] = await Promise.all([
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
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!existingSpeaker) {
      return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
    }

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

    const speaker = await db.speaker.update({
      where: { id: speakerId },
      data: {
        ...(data.title !== undefined && { title: data.title || null }),
        ...(data.firstName && { firstName: data.firstName }),
        ...(data.lastName && { lastName: data.lastName }),
        ...(data.bio !== undefined && { bio: data.bio || null }),
        ...(data.organization !== undefined && { organization: data.organization || null }),
        ...(data.jobTitle !== undefined && { jobTitle: data.jobTitle || null }),
        ...(data.phone !== undefined && { phone: data.phone || null }),
        ...(data.website !== undefined && { website: data.website || null }),
        ...(data.photo !== undefined && { photo: data.photo || null }),
        ...(data.city !== undefined && { city: data.city || null }),
        ...(data.country !== undefined && { country: data.country || null }),
        ...(data.specialty !== undefined && { specialty: data.specialty || null }),
        ...(data.registrationType !== undefined && { registrationType: data.registrationType || null }),
        ...(data.tags !== undefined && { tags: data.tags }),
        ...(data.socialLinks && { socialLinks: data.socialLinks }),
        ...(data.status && { status: data.status }),
      },
      include: {
        _count: {
          select: {
            sessions: true,
            abstracts: true,
          },
        },
      },
    });

    // Sync updated speaker to org contact store (awaited — errors caught internally)
    await syncToContact({
      organizationId: session.user.organizationId!,
      eventId,
      email: speaker.email,
      firstName: speaker.firstName,
      lastName: speaker.lastName,
      title: speaker.title,
      organization: speaker.organization,
      jobTitle: speaker.jobTitle,
      phone: speaker.phone,
      photo: speaker.photo,
      city: speaker.city,
      country: speaker.country,
      bio: speaker.bio,
      specialty: speaker.specialty,
      registrationType: speaker.registrationType,
    });

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "Speaker",
        entityId: speaker.id,
        changes: {
          before: existingSpeaker,
          after: speaker,
          ip: getClientIp(req),
        },
      },
    });

    return NextResponse.json(speaker);
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

    await db.speaker.delete({
      where: { id: speakerId },
    });

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    // Clean up photo file if present
    if (speaker.photo) {
      deletePhoto(speaker.photo).catch((err) =>
        apiLogger.warn({ msg: "Failed to delete speaker photo", photo: speaker.photo, err })
      );
    }

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "Speaker",
        entityId: speakerId,
        changes: { deleted: speaker, ip: getClientIp(req) },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting speaker" });
    return NextResponse.json(
      { error: "Failed to delete speaker" },
      { status: 500 }
    );
  }
}
