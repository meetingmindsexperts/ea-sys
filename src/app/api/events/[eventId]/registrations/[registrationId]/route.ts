import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeTag } from "@/lib/utils";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";
import { titleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";

const updateRegistrationSchema = z.object({
  status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"]).optional(),
  paymentStatus: z.enum(["UNPAID", "PENDING", "PAID", "REFUNDED", "FAILED"]).optional(),
  notes: z.string().max(2000).optional(),
  attendee: z.object({
    title: titleEnum.optional().nullable(),
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    organization: z.string().max(255).optional(),
    jobTitle: z.string().max(255).optional(),
    phone: z.string().max(50).optional(),
    photo: z.string().max(500).optional().or(z.literal("")),
    city: z.string().max(255).optional(),
    country: z.string().max(255).optional(),
    bio: z.string().max(5000).optional(),
    specialty: z.string().max(255).optional(),
    registrationType: z.string().max(255).optional(),
    tags: z.array(z.string().max(100).transform(normalizeTag)).optional(),
    dietaryReqs: z.string().max(2000).optional(),
    customFields: z.record(z.string().max(100), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).optional(),
  }).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    // Parallelize all async operations
    const [{ eventId, registrationId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parallelize event check and registration fetch
    const [event, registration] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId!,
        },
        select: { id: true },
      }),
      db.registration.findFirst({
        where: {
          id: registrationId,
          eventId,
        },
        include: {
          attendee: true,
          ticketType: true,
          payments: {
            orderBy: { createdAt: "desc" },
          },
          accommodation: {
            include: {
              roomType: {
                include: {
                  hotel: {
                    select: { id: true, name: true },
                  },
                },
              },
            },
          },
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const response = NextResponse.json(registration);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching registration" });
    return NextResponse.json(
      { error: "Failed to fetch registration" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const { eventId, registrationId } = await params;
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

    const existingRegistration = await db.registration.findFirst({
      where: {
        id: registrationId,
        eventId,
      },
      include: { attendee: true },
    });

    if (!existingRegistration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = updateRegistrationSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { status, paymentStatus, notes, attendee } = validated.data;

    // Update attendee if provided
    if (attendee) {
      await db.attendee.update({
        where: { id: existingRegistration.attendeeId },
        data: {
          ...(attendee.title !== undefined && { title: attendee.title || null }),
          ...(attendee.firstName && { firstName: attendee.firstName }),
          ...(attendee.lastName && { lastName: attendee.lastName }),
          ...(attendee.organization !== undefined && { organization: attendee.organization || null }),
          ...(attendee.photo !== undefined && { photo: attendee.photo || null }),
          ...(attendee.jobTitle !== undefined && { jobTitle: attendee.jobTitle || null }),
          ...(attendee.phone !== undefined && { phone: attendee.phone || null }),
          ...(attendee.city !== undefined && { city: attendee.city || null }),
          ...(attendee.country !== undefined && { country: attendee.country || null }),
          ...(attendee.bio !== undefined && { bio: attendee.bio || null }),
          ...(attendee.specialty !== undefined && { specialty: attendee.specialty || null }),
          ...(attendee.registrationType !== undefined && { registrationType: attendee.registrationType || null }),
          ...(attendee.tags !== undefined && { tags: attendee.tags }),
          ...(attendee.dietaryReqs !== undefined && { dietaryReqs: attendee.dietaryReqs || null }),
          ...(attendee.customFields && { customFields: attendee.customFields }),
        },
      });

      // Sync updated attendee to org contact store (fire-and-forget)
      const a = existingRegistration.attendee;
      syncToContact({
        organizationId: session.user.organizationId!,
        eventId,
        email: a.email,
        firstName: attendee.firstName || a.firstName,
        lastName: attendee.lastName || a.lastName,
        title: attendee.title !== undefined ? (attendee.title || null) : a.title,
        organization: attendee.organization !== undefined ? (attendee.organization || null) : a.organization,
        jobTitle: attendee.jobTitle !== undefined ? (attendee.jobTitle || null) : a.jobTitle,
        phone: attendee.phone !== undefined ? (attendee.phone || null) : a.phone,
        photo: attendee.photo !== undefined ? (attendee.photo || null) : a.photo,
        city: attendee.city !== undefined ? (attendee.city || null) : a.city,
        country: attendee.country !== undefined ? (attendee.country || null) : a.country,
        bio: attendee.bio !== undefined ? (attendee.bio || null) : a.bio,
        specialty: attendee.specialty !== undefined ? (attendee.specialty || null) : a.specialty,
        registrationType: attendee.registrationType !== undefined ? (attendee.registrationType || null) : a.registrationType,
      });
    }

    // Handle ticket count updates for cancellation
    if (status === "CANCELLED" && existingRegistration.status !== "CANCELLED") {
      await db.ticketType.update({
        where: { id: existingRegistration.ticketTypeId },
        data: { soldCount: { decrement: 1 } },
      });
    } else if (status !== "CANCELLED" && existingRegistration.status === "CANCELLED") {
      await db.ticketType.update({
        where: { id: existingRegistration.ticketTypeId },
        data: { soldCount: { increment: 1 } },
      });
    }

    const registration = await db.registration.update({
      where: { id: registrationId },
      data: {
        ...(status && { status }),
        ...(paymentStatus && { paymentStatus }),
        ...(notes !== undefined && { notes: notes || null }),
      },
      include: {
        attendee: true,
        ticketType: true,
      },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "Registration",
        entityId: registration.id,
        changes: {
          before: existingRegistration,
          after: registration,
          ip: getClientIp(req),
        },
      },
    });

    return NextResponse.json(registration);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating registration" });
    return NextResponse.json(
      { error: "Failed to update registration" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { eventId, registrationId } = await params;
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

    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        eventId,
      },
    });

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    // Update ticket sold count
    if (registration.status !== "CANCELLED") {
      await db.ticketType.update({
        where: { id: registration.ticketTypeId },
        data: { soldCount: { decrement: 1 } },
      });
    }

    await db.registration.delete({
      where: { id: registrationId },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "Registration",
        entityId: registrationId,
        changes: { deleted: registration, ip: getClientIp(req) },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting registration" });
    return NextResponse.json(
      { error: "Failed to delete registration" },
      { status: 500 }
    );
  }
}
