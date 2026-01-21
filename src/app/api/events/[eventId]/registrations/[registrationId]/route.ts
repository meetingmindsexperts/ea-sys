import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

const updateRegistrationSchema = z.object({
  status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"]).optional(),
  paymentStatus: z.enum(["UNPAID", "PENDING", "PAID", "REFUNDED", "FAILED"]).optional(),
  notes: z.string().optional(),
  attendee: z.object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    company: z.string().optional(),
    jobTitle: z.string().optional(),
    phone: z.string().optional(),
    dietaryReqs: z.string().optional(),
    customFields: z.record(z.any()).optional(),
  }).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { eventId, registrationId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
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
                hotel: true,
              },
            },
          },
        },
      },
    });

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    return NextResponse.json(registration);
  } catch (error) {
    console.error("Error fetching registration:", error);
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

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
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
          ...(attendee.firstName && { firstName: attendee.firstName }),
          ...(attendee.lastName && { lastName: attendee.lastName }),
          ...(attendee.company !== undefined && { company: attendee.company || null }),
          ...(attendee.jobTitle !== undefined && { jobTitle: attendee.jobTitle || null }),
          ...(attendee.phone !== undefined && { phone: attendee.phone || null }),
          ...(attendee.dietaryReqs !== undefined && { dietaryReqs: attendee.dietaryReqs || null }),
          ...(attendee.customFields && { customFields: attendee.customFields }),
        },
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
        },
      },
    });

    return NextResponse.json(registration);
  } catch (error) {
    console.error("Error updating registration:", error);
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

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
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
        changes: { deleted: registration },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting registration:", error);
    return NextResponse.json(
      { error: "Failed to delete registration" },
      { status: 500 }
    );
  }
}
