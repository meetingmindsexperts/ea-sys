import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { createPromoCode, type CreatePromoCodeErrorCode } from "@/services/promo-code-service";

const HTTP_STATUS_FOR_PROMO_CREATE: Record<CreatePromoCodeErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  INVALID_CODE: 400,
  INVALID_DISCOUNT: 400,
  INVALID_TICKET_TYPES: 400,
  DUPLICATE_CODE: 409,
  UNKNOWN: 500,
};

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
      apiLogger.warn({ msg: "events/promo-codes:invalid-input", errors: parsed.error.flatten() });
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { ticketTypeIds, ...data } = parsed.data;

    // Domain logic lives in promo-code-service.createPromoCode (shared with the
    // MCP create_promo_code tool) — this route keeps auth, Zod, and HTTP mapping.
    const result = await createPromoCode({
      eventId,
      organizationId: session.user.organizationId!,
      actorUserId: session.user.id,
      source: "rest",
      code: data.code,
      description: data.description ?? null,
      discountType: data.discountType,
      discountValue: data.discountValue,
      currency: data.currency ?? null,
      maxUses: data.maxUses ?? null,
      maxUsesPerEmail: data.maxUsesPerEmail ?? 1,
      validFrom: data.validFrom ? new Date(data.validFrom) : null,
      validUntil: data.validUntil ? new Date(data.validUntil) : null,
      isActive: data.isActive,
      ticketTypeIds,
    });

    if (!result.ok) {
      const status = HTTP_STATUS_FOR_PROMO_CREATE[result.code] ?? 500;
      apiLogger.warn({ msg: "events/promo-codes:create-rejected", eventId, code: result.code });
      return NextResponse.json({ error: result.message, code: result.code }, { status });
    }

    return NextResponse.json(result.promoCode, { status: 201 });
  } catch (error) {
    apiLogger.error({ error, msg: "Failed to create promo code" });
    return NextResponse.json(
      { error: "Failed to create promo code" },
      { status: 500 }
    );
  }
}
