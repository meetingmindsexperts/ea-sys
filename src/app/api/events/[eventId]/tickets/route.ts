import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";

export const DEFAULT_REG_TYPES = [
  { name: "Physician", sortOrder: 0 },
  { name: "Allied Health", sortOrder: 1 },
  { name: "Student", sortOrder: 2 },
  { name: "Resident", sortOrder: 3 },
];

const createTicketTypeSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().optional(),
  // Optional: create initial pricing tiers alongside the registration type
  pricingTiers: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        price: z.number().min(0),
        currency: z.string().max(10).default("USD"),
        quantity: z.number().min(1).default(999999),
        maxPerOrder: z.number().min(1).default(10),
        salesStart: z.string().datetime().optional(),
        salesEnd: z.string().datetime().optional(),
        isActive: z.boolean().default(true),
        requiresApproval: z.boolean().default(false),
        sortOrder: z.number().int().optional(),
      })
    )
    .optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [event, ticketTypes] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId!,
        },
        select: { id: true },
      }),
      db.ticketType.findMany({
        where: { eventId },
        include: {
          pricingTiers: {
            orderBy: { sortOrder: "asc" },
            include: {
              _count: { select: { registrations: true } },
            },
          },
          _count: {
            select: { registrations: true },
          },
        },
        orderBy: { sortOrder: "asc" },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const response = NextResponse.json(ticketTypes);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
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
    const [{ eventId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

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
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const validated = createTicketTypeSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { name, description, isActive, sortOrder, pricingTiers } = validated.data;

    // Check for duplicate name within the event
    const existing = await db.ticketType.findFirst({
      where: { eventId, name },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: `Registration type "${name}" already exists for this event` },
        { status: 409 }
      );
    }

    const ticketType = await db.ticketType.create({
      data: {
        eventId,
        name,
        description: description || null,
        isActive,
        sortOrder: sortOrder ?? 99,
        ...(pricingTiers && pricingTiers.length > 0
          ? {
              pricingTiers: {
                create: pricingTiers.map((tier, i) => ({
                  name: tier.name,
                  price: tier.price,
                  currency: tier.currency,
                  quantity: tier.quantity,
                  maxPerOrder: tier.maxPerOrder,
                  salesStart: tier.salesStart ? new Date(tier.salesStart) : null,
                  salesEnd: tier.salesEnd ? new Date(tier.salesEnd) : null,
                  isActive: tier.isActive,
                  requiresApproval: tier.requiresApproval,
                  sortOrder: tier.sortOrder ?? i,
                })),
              },
            }
          : {}),
      },
      include: {
        pricingTiers: {
          orderBy: { sortOrder: "asc" },
          include: { _count: { select: { registrations: true } } },
        },
        _count: { select: { registrations: true } },
      },
    });

    apiLogger.info({ msg: "Registration type created", eventId, ticketTypeId: ticketType.id, name, userId: session.user.id });

    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "TicketType",
        entityId: ticketType.id,
        changes: { ...JSON.parse(JSON.stringify({ ticketType })), ip: getClientIp(req) },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    return NextResponse.json(ticketType, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating registration type" });
    return NextResponse.json(
      { error: "Failed to create registration type" },
      { status: 500 }
    );
  }
}
