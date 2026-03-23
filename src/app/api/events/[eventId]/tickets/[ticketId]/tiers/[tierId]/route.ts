import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";

const updateTierSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  price: z.number().min(0).optional(),
  currency: z.string().max(10).optional(),
  quantity: z.number().min(1).optional(),
  maxPerOrder: z.number().min(1).optional(),
  salesStart: z.string().datetime().nullable().optional(),
  salesEnd: z.string().datetime().nullable().optional(),
  isActive: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; ticketId: string; tierId: string }>;
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, ticketId, tierId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, tier] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.pricingTier.findFirst({
        where: { id: tierId, ticketTypeId: ticketId, ticketType: { eventId } },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!tier) {
      return NextResponse.json({ error: "Pricing tier not found" }, { status: 404 });
    }

    const validated = updateTierSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    // Ensure quantity is not less than soldCount
    if (data.quantity !== undefined && data.quantity < tier.soldCount) {
      return NextResponse.json(
        { error: `Quantity cannot be less than sold count (${tier.soldCount})` },
        { status: 400 }
      );
    }

    // Check uniqueness if name is changing
    if (data.name && data.name !== tier.name) {
      const dup = await db.pricingTier.findFirst({
        where: { ticketTypeId: ticketId, name: data.name, id: { not: tierId } },
        select: { id: true },
      });
      if (dup) {
        return NextResponse.json(
          { error: `Pricing tier "${data.name}" already exists` },
          { status: 409 }
        );
      }
    }

    const updated = await db.pricingTier.update({
      where: { id: tierId },
      data: {
        ...(data.name && { name: data.name }),
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
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      },
      include: { _count: { select: { registrations: true } } },
    });

    apiLogger.info({ msg: "Pricing tier updated", eventId, ticketTypeId: ticketId, tierId, userId: session.user.id });

    return NextResponse.json(updated);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating pricing tier" });
    return NextResponse.json(
      { error: "Failed to update pricing tier" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, ticketId, tierId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, tier] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.pricingTier.findFirst({
        where: { id: tierId, ticketTypeId: ticketId, ticketType: { eventId } },
        include: { _count: { select: { registrations: true } } },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!tier) {
      return NextResponse.json({ error: "Pricing tier not found" }, { status: 404 });
    }

    if (tier._count.registrations > 0) {
      return NextResponse.json(
        { error: "Cannot delete pricing tier with existing registrations" },
        { status: 400 }
      );
    }

    await db.pricingTier.delete({ where: { id: tierId } });

    apiLogger.info({ msg: "Pricing tier deleted", eventId, ticketTypeId: ticketId, tierId, tierName: tier.name, userId: session.user.id });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting pricing tier" });
    return NextResponse.json(
      { error: "Failed to delete pricing tier" },
      { status: 500 }
    );
  }
}
