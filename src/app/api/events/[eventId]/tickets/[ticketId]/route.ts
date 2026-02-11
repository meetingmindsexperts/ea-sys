import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";

const updateTicketTypeSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  price: z.number().min(0).optional(),
  currency: z.string().optional(),
  quantity: z.number().min(1).optional(),
  maxPerOrder: z.number().min(1).optional(),
  salesStart: z.string().datetime().nullable().optional(),
  salesEnd: z.string().datetime().nullable().optional(),
  isActive: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; ticketId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { eventId, ticketId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId!,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const ticketType = await db.ticketType.findFirst({
      where: {
        id: ticketId,
        eventId,
      },
      include: {
        _count: {
          select: { registrations: true },
        },
      },
    });

    if (!ticketType) {
      return NextResponse.json({ error: "Ticket type not found" }, { status: 404 });
    }

    return NextResponse.json(ticketType);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching ticket type" });
    return NextResponse.json(
      { error: "Failed to fetch ticket type" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const { eventId, ticketId } = await params;
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

    const existingTicketType = await db.ticketType.findFirst({
      where: {
        id: ticketId,
        eventId,
      },
    });

    if (!existingTicketType) {
      return NextResponse.json({ error: "Ticket type not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = updateTicketTypeSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    // Ensure quantity is not less than soldCount
    if (data.quantity !== undefined && data.quantity < existingTicketType.soldCount) {
      return NextResponse.json(
        { error: `Quantity cannot be less than sold count (${existingTicketType.soldCount})` },
        { status: 400 }
      );
    }

    const ticketType = await db.ticketType.update({
      where: { id: ticketId },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.description !== undefined && { description: data.description || null }),
        ...(data.price !== undefined && { price: data.price }),
        ...(data.currency && { currency: data.currency }),
        ...(data.quantity !== undefined && { quantity: data.quantity }),
        ...(data.maxPerOrder !== undefined && { maxPerOrder: data.maxPerOrder }),
        ...(data.salesStart !== undefined && {
          salesStart: data.salesStart ? new Date(data.salesStart) : null,
        }),
        ...(data.salesEnd !== undefined && {
          salesEnd: data.salesEnd ? new Date(data.salesEnd) : null,
        }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(data.requiresApproval !== undefined && { requiresApproval: data.requiresApproval }),
      },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "TicketType",
        entityId: ticketType.id,
        changes: {
          before: existingTicketType,
          after: ticketType,
        },
      },
    });

    return NextResponse.json(ticketType);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating ticket type" });
    return NextResponse.json(
      { error: "Failed to update ticket type" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { eventId, ticketId } = await params;
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

    const ticketType = await db.ticketType.findFirst({
      where: {
        id: ticketId,
        eventId,
      },
      include: {
        _count: {
          select: { registrations: true },
        },
      },
    });

    if (!ticketType) {
      return NextResponse.json({ error: "Ticket type not found" }, { status: 404 });
    }

    // Don't allow deletion if there are registrations
    if (ticketType._count.registrations > 0) {
      return NextResponse.json(
        { error: "Cannot delete ticket type with existing registrations" },
        { status: 400 }
      );
    }

    await db.ticketType.delete({
      where: { id: ticketId },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "TicketType",
        entityId: ticketId,
        changes: { deleted: ticketType },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting ticket type" });
    return NextResponse.json(
      { error: "Failed to delete ticket type" },
      { status: 500 }
    );
  }
}
