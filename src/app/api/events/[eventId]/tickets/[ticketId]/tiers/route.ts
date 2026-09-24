import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { runWithTenant } from "@/lib/tenant-context";

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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/tickets/[ticketId]/tiers:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW, route: "events/[eventId]/tickets/[ticketId]/tiers:POST" });
    if (denied) return denied;

    // Tenancy sweep (B1 fix): wrap opens BEFORE the swept ticketType read.
    return await runWithTenant(orgGuard.orgId, async () => {
    const [event, ticketType] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
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
        apiLogger.warn({ msg: "events/tickets/tiers:zod-validation-failed", errors: validated.error.flatten() });
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
      apiLogger.warn({ msg: "pricing-tier:create-duplicate-name", eventId, ticketTypeId: ticketId, tierName: data.name, userId: session.user.id });
      return NextResponse.json(
        { error: `Pricing tier "${data.name}" already exists for this registration type` },
        { status: 409 }
      );
    }

    // Auto-assign sortOrder based on existing tier count
    const existingCount = await db.pricingTier.count({ where: { ticketTypeId: ticketId } });

    const tier = await db.pricingTier.create({
      data: {
        ticketTypeId: ticketId,
        organizationId: orgGuard.orgId,
        name: data.name,
        price: data.price,
        currency: data.currency,
        quantity: data.quantity,
        maxPerOrder: data.maxPerOrder,
        salesStart: data.salesStart ? new Date(data.salesStart) : null,
        salesEnd: data.salesEnd ? new Date(data.salesEnd) : null,
        isActive: data.isActive,
        requiresApproval: data.requiresApproval,
        sortOrder: data.sortOrder ?? existingCount,
      },
      include: { _count: { select: { registrations: true } } },
    });

    apiLogger.info({ msg: "Pricing tier created", eventId, ticketTypeId: ticketId, tierId: tier.id, tierName: data.name, userId: session.user.id });

    return NextResponse.json(tier, { status: 201 });
    });
  } catch (error) {
    // Two creates with the same name can both pass the check above (a double
    // submit); the unique index refuses the second, which is the same answer.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      apiLogger.warn({ msg: "pricing-tier:create-duplicate-name-race", target: error.meta?.target });
      return NextResponse.json(
        { error: "A pricing tier with this name already exists for this registration type" },
        { status: 409 }
      );
    }
    apiLogger.error({ err: error, msg: "Error creating pricing tier" });
    return NextResponse.json(
      { error: "Failed to create pricing tier" },
      { status: 500 }
    );
  }
}
