import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";

/**
 * GET /api/registrant/registrations
 * Returns all registrations linked to the current user.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const registrations = await db.registration.findMany({
      where: { userId: session.user.id },
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
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { registrationId, attendee } = validated.data;

    // Verify ownership
    const registration = await db.registration.findFirst({
      where: { id: registrationId, userId: session.user.id },
      select: { id: true, attendeeId: true },
    });

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    // Update attendee fields only
    await db.attendee.update({
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
      },
    });

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
