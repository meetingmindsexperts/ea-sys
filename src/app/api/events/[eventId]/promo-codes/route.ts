import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";

const createPromoCodeSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(50)
      .transform((v) => v.toUpperCase().trim()),
    description: z.string().max(2000).optional(),
    discountType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]),
    discountValue: z.number().min(0.01),
    currency: z.string().max(10).optional(),
    maxUses: z.number().int().min(1).nullable().optional(),
    maxUsesPerEmail: z.number().int().min(1).nullable().optional().default(1),
    validFrom: z.string().datetime().nullable().optional(),
    validUntil: z.string().datetime().nullable().optional(),
    isActive: z.boolean().default(true),
    ticketTypeIds: z.array(z.string()).optional(),
  })
  .refine(
    (d) => d.discountType !== "PERCENTAGE" || d.discountValue <= 100,
    { message: "Percentage discount cannot exceed 100%" }
  )
  .refine(
    (d) => d.discountType !== "FIXED_AMOUNT" || d.currency,
    { message: "Currency is required for fixed amount discounts" }
  );

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [event, promoCodes] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      }),
      db.promoCode.findMany({
        where: { eventId },
        include: {
          ticketTypes: {
            include: { ticketType: { select: { id: true, name: true } } },
          },
          _count: { select: { redemptions: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return NextResponse.json(promoCodes);
  } catch (error) {
    apiLogger.error({ error, msg: "Failed to list promo codes" });
    return NextResponse.json(
      { error: "Failed to list promo codes" },
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

    const parsed = createPromoCodeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const { ticketTypeIds, ...data } = parsed.data;

    // Check for duplicate code
    const existing = await db.promoCode.findUnique({
      where: { eventId_code: { eventId, code: data.code } },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: "A promo code with this code already exists" },
        { status: 409 }
      );
    }

    const promoCode = await db.promoCode.create({
      data: {
        eventId,
        code: data.code,
        description: data.description,
        discountType: data.discountType,
        discountValue: data.discountValue,
        currency: data.currency,
        maxUses: data.maxUses ?? null,
        maxUsesPerEmail: data.maxUsesPerEmail ?? 1,
        validFrom: data.validFrom ? new Date(data.validFrom) : null,
        validUntil: data.validUntil ? new Date(data.validUntil) : null,
        isActive: data.isActive,
        ...(ticketTypeIds && ticketTypeIds.length > 0
          ? {
              ticketTypes: {
                create: ticketTypeIds.map((ticketTypeId) => ({
                  ticketTypeId,
                })),
              },
            }
          : {}),
      },
      include: {
        ticketTypes: {
          include: { ticketType: { select: { id: true, name: true } } },
        },
        _count: { select: { redemptions: true } },
      },
    });

    // Non-blocking audit log
    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "CREATE_PROMO_CODE",
          entityType: "PromoCode",
          entityId: promoCode.id,
          changes: { code: promoCode.code, discountType: promoCode.discountType, discountValue: Number(promoCode.discountValue) },
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "Audit log failed" }));

    return NextResponse.json(promoCode, { status: 201 });
  } catch (error) {
    apiLogger.error({ error, msg: "Failed to create promo code" });
    return NextResponse.json(
      { error: "Failed to create promo code" },
      { status: 500 }
    );
  }
}
