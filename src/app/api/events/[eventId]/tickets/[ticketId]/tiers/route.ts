import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";

const createTierSchema = z.object({
  name: z.string().min(1).max(100),
  price: z.number().min(0),
  currency: z.string().max(10).default("USD"),
  quantity: z.number().min(1).default(999999),
  maxPerOrder: z.number().min(1).default(10),
  salesStart: z.string().datetime().nullable().optional(),
  salesEnd: z.string().datetime().nullable().optional(),
  isActive: z.boolean().default(true),
  requiresApproval: z.boolean().default(false),
  sortOrder: z.number().int().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; ticketId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, ticketId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, ticketType] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.ticketType.findFirst({
        where: { id: ticketId, eventId },
        select: { id: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!ticketType) {
      return NextResponse.json({ error: "Registration type not found" }, { status: 404 });
    }

    const validated = createTierSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    // Check for duplicate tier name within the registration type
    const existing = await db.pricingTier.findFirst({
      where: { ticketTypeId: ticketId, name: data.name },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: `Pricing tier "${data.name}" already exists for this registration type` },
        { status: 409 }
      );
    }

    const tier = await db.pricingTier.create({
      data: {
        ticketTypeId: ticketId,
        name: data.name,
        price: data.price,
        currency: data.currency,
        quantity: data.quantity,
        maxPerOrder: data.maxPerOrder,
        salesStart: data.salesStart ? new Date(data.salesStart) : null,
        salesEnd: data.salesEnd ? new Date(data.salesEnd) : null,
        isActive: data.isActive,
        requiresApproval: data.requiresApproval,
        sortOrder: data.sortOrder ?? 0,
      },
      include: { _count: { select: { registrations: true } } },
    });

    apiLogger.info({ msg: "Pricing tier created", eventId, ticketTypeId: ticketId, tierId: tier.id, tierName: data.name, userId: session.user.id });

    return NextResponse.json(tier, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating pricing tier" });
    return NextResponse.json(
      { error: "Failed to create pricing tier" },
      { status: 500 }
    );
  }
}
