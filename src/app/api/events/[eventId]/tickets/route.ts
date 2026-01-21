import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

const createTicketTypeSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  price: z.number().min(0),
  currency: z.string().default("USD"),
  quantity: z.number().min(1),
  maxPerOrder: z.number().min(1).default(10),
  salesStart: z.string().datetime().optional(),
  salesEnd: z.string().datetime().optional(),
  isActive: z.boolean().default(true),
  requiresApproval: z.boolean().default(false),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { eventId } = await params;
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

    const ticketTypes = await db.ticketType.findMany({
      where: { eventId },
      include: {
        _count: {
          select: { registrations: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json(ticketTypes);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching ticket types" });
    return NextResponse.json(
      { error: "Failed to fetch ticket types" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { eventId } = await params;
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

    const body = await req.json();
    const validated = createTicketTypeSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const {
      name,
      description,
      price,
      currency,
      quantity,
      maxPerOrder,
      salesStart,
      salesEnd,
      isActive,
      requiresApproval,
    } = validated.data;

    const ticketType = await db.ticketType.create({
      data: {
        eventId,
        name,
        description: description || null,
        price,
        currency,
        quantity,
        maxPerOrder,
        salesStart: salesStart ? new Date(salesStart) : null,
        salesEnd: salesEnd ? new Date(salesEnd) : null,
        isActive,
        requiresApproval,
      },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "TicketType",
        entityId: ticketType.id,
        changes: { ticketType },
      },
    });

    return NextResponse.json(ticketType, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating ticket type" });
    return NextResponse.json(
      { error: "Failed to create ticket type" },
      { status: 500 }
    );
  }
}
