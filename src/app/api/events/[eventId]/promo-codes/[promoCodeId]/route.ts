import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";

const updatePromoCodeSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(50)
      .transform((v) => v.toUpperCase().trim())
      .optional(),
    description: z.string().max(2000).nullable().optional(),
    discountType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]).optional(),
    discountValue: z.number().min(0.01).optional(),
    currency: z.string().max(10).nullable().optional(),
    maxUses: z.number().int().min(1).nullable().optional(),
    maxUsesPerEmail: z.number().int().min(1).nullable().optional(),
    validFrom: z.string().datetime().nullable().optional(),
    validUntil: z.string().datetime().nullable().optional(),
    isActive: z.boolean().optional(),
    ticketTypeIds: z.array(z.string()).optional(),
  })
  .refine(
    (d) => !d.discountType || d.discountType !== "PERCENTAGE" || !d.discountValue || d.discountValue <= 100,
    { message: "Percentage discount cannot exceed 100%" }
  );

interface RouteParams {
  params: Promise<{ eventId: string; promoCodeId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, promoCodeId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const promoCode = await db.promoCode.findFirst({
      where: { id: promoCodeId, eventId },
      include: {
        ticketTypes: {
          include: { ticketType: { select: { id: true, name: true } } },
        },
        redemptions: {
          orderBy: { createdAt: "desc" },
          take: 50,
          select: {
            id: true,
            email: true,
            originalPrice: true,
            discountAmount: true,
            finalPrice: true,
            createdAt: true,
            registration: {
              select: {
                id: true,
                attendee: { select: { firstName: true, lastName: true } },
              },
            },
          },
        },
        _count: { select: { redemptions: true } },
      },
    });

    if (!promoCode) {
      return NextResponse.json(
        { error: "Promo code not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(promoCode);
  } catch (error) {
    apiLogger.error({ error, msg: "Failed to get promo code" });
    return NextResponse.json(
      { error: "Failed to get promo code" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, promoCodeId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const parsed = updatePromoCodeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const [event, existing] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.promoCode.findFirst({
        where: { id: promoCodeId, eventId },
        select: { id: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!existing) {
      return NextResponse.json(
        { error: "Promo code not found" },
        { status: 404 }
      );
    }

    const { ticketTypeIds, ...data } = parsed.data;

    // Check for duplicate code if code is being changed
    if (data.code) {
      const duplicate = await db.promoCode.findFirst({
        where: { eventId, code: data.code, id: { not: promoCodeId } },
        select: { id: true },
      });
      if (duplicate) {
        return NextResponse.json(
          { error: "A promo code with this code already exists" },
          { status: 409 }
        );
      }
    }

    const promoCode = await db.$transaction(async (tx) => {
      // Update ticket type associations if provided
      if (ticketTypeIds !== undefined) {
        await tx.promoCodeTicketType.deleteMany({
          where: { promoCodeId },
        });
        if (ticketTypeIds.length > 0) {
          await tx.promoCodeTicketType.createMany({
            data: ticketTypeIds.map((ticketTypeId) => ({
              promoCodeId,
              ticketTypeId,
            })),
          });
        }
      }

      return tx.promoCode.update({
        where: { id: promoCodeId },
        data: {
          ...(data.code !== undefined && { code: data.code }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.discountType !== undefined && { discountType: data.discountType }),
          ...(data.discountValue !== undefined && { discountValue: data.discountValue }),
          ...(data.currency !== undefined && { currency: data.currency }),
          ...(data.maxUses !== undefined && { maxUses: data.maxUses }),
          ...(data.maxUsesPerEmail !== undefined && { maxUsesPerEmail: data.maxUsesPerEmail }),
          ...(data.validFrom !== undefined && { validFrom: data.validFrom ? new Date(data.validFrom) : null }),
          ...(data.validUntil !== undefined && { validUntil: data.validUntil ? new Date(data.validUntil) : null }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
        },
        include: {
          ticketTypes: {
            include: { ticketType: { select: { id: true, name: true } } },
          },
          _count: { select: { redemptions: true } },
        },
      });
    });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE_PROMO_CODE",
          entityType: "PromoCode",
          entityId: promoCode.id,
          changes: { code: promoCode.code },
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "Audit log failed" }));

    return NextResponse.json(promoCode);
  } catch (error) {
    apiLogger.error({ error, msg: "Failed to update promo code" });
    return NextResponse.json(
      { error: "Failed to update promo code" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, promoCodeId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, promoCode] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.promoCode.findFirst({
        where: { id: promoCodeId, eventId },
        select: { id: true, code: true, _count: { select: { redemptions: true } } },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!promoCode) {
      return NextResponse.json(
        { error: "Promo code not found" },
        { status: 404 }
      );
    }

    // If code has been used, soft-delete (deactivate). Otherwise hard-delete.
    if (promoCode._count.redemptions > 0) {
      await db.promoCode.update({
        where: { id: promoCodeId },
        data: { isActive: false },
      });
    } else {
      await db.promoCode.delete({ where: { id: promoCodeId } });
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "DELETE_PROMO_CODE",
          entityType: "PromoCode",
          entityId: promoCodeId,
          changes: { code: promoCode.code },
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "Audit log failed" }));

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ error, msg: "Failed to delete promo code" });
    return NextResponse.json(
      { error: "Failed to delete promo code" },
      { status: 500 }
    );
  }
}
