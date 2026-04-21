import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";

/**
 * GET /api/registrant/registrations
 * Returns all registrations linked to the current user.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id || !session.user.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Auto-link orphan registrations: people often register for an event
    // without a password (admin-created, CSV-imported, or self-signup with
    // the password field skipped) so the Registration has no userId. When
    // they later sign in with the same email, any unlinked Registration for
    // that email should show up on their portal. We link-on-read here so
    // the row both appears in THIS response and stays linked for future
    // requests.
    const userEmail = session.user.email.toLowerCase();
    await db.registration.updateMany({
      where: {
        userId: null,
        attendee: { email: userEmail },
      },
      data: { userId: session.user.id },
    }).catch((err) => {
      apiLogger.warn({ err, msg: "registrant:orphan-link-failed", userId: session.user.id });
    });

    const registrations = await db.registration.findMany({
      where: {
        OR: [
          { userId: session.user.id },
          // Safety net for any registration that slipped past the
          // updateMany above (e.g. attendee email updated after the link
          // race condition). Scoped strictly to rows matching the
          // authenticated user's email — they can't see anyone else's.
          { attendee: { email: userEmail } },
        ],
      },
      include: {
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            startDate: true,
            endDate: true,
            venue: true,
            city: true,
            country: true,
            bannerImage: true,
            taxRate: true,
            taxLabel: true,
          },
        },
        attendee: true,
        ticketType: { select: { id: true, name: true, price: true, currency: true } },
        pricingTier: { select: { id: true, name: true, price: true, currency: true } },
        payments: {
          select: { id: true, amount: true, currency: true, status: true, receiptUrl: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(registrations);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching registrant registrations" });
    return NextResponse.json({ error: "Failed to fetch registrations" }, { status: 500 });
  }
}

const selfEditSchema = z.object({
  registrationId: z.string().min(1),
  attendee: z.object({
    title: titleEnum.optional().nullable(),
    role: attendeeRoleEnum.optional(),
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    organization: z.string().max(255).optional(),
    jobTitle: z.string().max(255).optional(),
    phone: z.string().max(50).optional(),
    city: z.string().max(255).optional(),
    country: z.string().max(255).optional(),
    specialty: z.string().max(255).optional(),
    dietaryReqs: z.string().max(2000).optional(),
    associationName: z.string().max(255).optional().nullable(),
    memberId: z.string().max(100).optional().nullable(),
    studentId: z.string().max(100).optional().nullable(),
    studentIdExpiry: z.string().max(20).optional().nullable(),
  }),
});

/**
 * PUT /api/registrant/registrations
 * Allows a registrant to edit their own attendee details.
 */
export async function PUT(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const validated = selfEditSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "Registrant self-edit validation failed", userId: session.user.id, errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { registrationId, attendee } = validated.data;

    // Validate studentIdExpiry date format if provided
    if (attendee.studentIdExpiry && isNaN(new Date(attendee.studentIdExpiry).getTime())) {
      apiLogger.warn({ msg: "Invalid studentIdExpiry date in self-edit", userId: session.user.id, studentIdExpiry: attendee.studentIdExpiry });
      return NextResponse.json({ error: "Invalid student ID expiry date" }, { status: 400 });
    }

    // Verify ownership
    const registration = await db.registration.findFirst({
      where: { id: registrationId, userId: session.user.id },
      select: { id: true, attendeeId: true, eventId: true },
    });

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    // Update attendee fields only
    const updatedAttendee = await db.attendee.update({
      where: { id: registration.attendeeId },
      data: {
        ...(attendee.title !== undefined && { title: attendee.title || null }),
        ...(attendee.role !== undefined && { role: attendee.role }),
        ...(attendee.firstName && { firstName: attendee.firstName }),
        ...(attendee.lastName && { lastName: attendee.lastName }),
        ...(attendee.organization !== undefined && { organization: attendee.organization || null }),
        ...(attendee.jobTitle !== undefined && { jobTitle: attendee.jobTitle || null }),
        ...(attendee.phone !== undefined && { phone: attendee.phone || null }),
        ...(attendee.city !== undefined && { city: attendee.city || null }),
        ...(attendee.country !== undefined && { country: attendee.country || null }),
        ...(attendee.specialty !== undefined && { specialty: attendee.specialty || null }),
        ...(attendee.dietaryReqs !== undefined && { dietaryReqs: attendee.dietaryReqs || null }),
        ...(attendee.associationName !== undefined && { associationName: attendee.associationName || null }),
        ...(attendee.memberId !== undefined && { memberId: attendee.memberId || null }),
        ...(attendee.studentId !== undefined && { studentId: attendee.studentId || null }),
        ...(attendee.studentIdExpiry !== undefined && { studentIdExpiry: attendee.studentIdExpiry ? new Date(attendee.studentIdExpiry) : null }),
      },
    });

    // Sync updated attendee to org contact store
    const event = await db.event.findFirst({
      where: { id: registration.eventId },
      select: { organizationId: true },
    });
    if (event) {
      await syncToContact({
        organizationId: event.organizationId,
        eventId: registration.eventId,
        email: updatedAttendee.email,
        firstName: updatedAttendee.firstName,
        lastName: updatedAttendee.lastName,
        title: updatedAttendee.title,
        organization: updatedAttendee.organization,
        jobTitle: updatedAttendee.jobTitle,
        phone: updatedAttendee.phone,
        city: updatedAttendee.city,
        country: updatedAttendee.country,
        specialty: updatedAttendee.specialty,
        registrationType: updatedAttendee.registrationType,
        associationName: updatedAttendee.associationName,
        memberId: updatedAttendee.memberId,
        studentId: updatedAttendee.studentId,
        studentIdExpiry: updatedAttendee.studentIdExpiry,
      });
    }

    // Return updated registration
    const updated = await db.registration.findFirst({
      where: { id: registrationId },
      include: {
        event: {
          select: {
            id: true, name: true, slug: true, startDate: true, endDate: true,
            venue: true, city: true, country: true, bannerImage: true,
          },
        },
        attendee: true,
        ticketType: { select: { id: true, name: true, price: true, currency: true } },
        pricingTier: { select: { id: true, name: true, price: true, currency: true } },
        payments: {
          select: { id: true, amount: true, currency: true, status: true, receiptUrl: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating registrant registration" });
    return NextResponse.json({ error: "Failed to update registration" }, { status: 500 });
  }
}
