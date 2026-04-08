import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";

const validatePromoSchema = z.object({
  code: z.string().min(1).max(50),
  ticketTypeId: z.string().min(1),
  pricingTierId: z.string().optional(),
  email: z.string().email(),
});

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const ip = getClientIp(req);
    const rl = checkRateLimit({
      key: `validate-promo:${ip}`,
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
      );
    }

    const [{ slug }, body] = await Promise.all([params, req.json()]);

    const parsed = validatePromoSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { code, ticketTypeId, pricingTierId, email } = parsed.data;

    const event = await db.event.findFirst({
      where: { slug, status: "PUBLISHED" },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const promoCode = await db.promoCode.findUnique({
      where: { eventId_code: { eventId: event.id, code: code.toUpperCase().trim() } },
      include: { ticketTypes: { select: { ticketTypeId: true } } },
    });

    if (!promoCode || !promoCode.isActive) {
      return NextResponse.json({ valid: false, error: "Invalid promo code" });
    }

    // Date range check
    const now = new Date();
    if (promoCode.validFrom && now < promoCode.validFrom) {
      return NextResponse.json({ valid: false, error: "Promo code is not yet active" });
    }
    if (promoCode.validUntil && now > promoCode.validUntil) {
      return NextResponse.json({ valid: false, error: "Promo code has expired" });
    }

    // Max uses check
    if (promoCode.maxUses !== null && promoCode.usedCount >= promoCode.maxUses) {
      return NextResponse.json({ valid: false, error: "Promo code usage limit reached" });
    }

    // Per-email check
    if (promoCode.maxUsesPerEmail !== null) {
      const emailUses = await db.promoCodeRedemption.count({
        where: { promoCodeId: promoCode.id, email: email.toLowerCase() },
      });
      if (emailUses >= promoCode.maxUsesPerEmail) {
        return NextResponse.json({ valid: false, error: "Promo code already used with this email" });
      }
    }

    // Ticket type applicability
    if (promoCode.ticketTypes.length > 0) {
      const applicable = promoCode.ticketTypes.some(
        (t) => t.ticketTypeId === ticketTypeId
      );
      if (!applicable) {
        return NextResponse.json({ valid: false, error: "Promo code not applicable to this ticket type" });
      }
    }

    // Determine price
    let originalPrice = 0;
    if (pricingTierId) {
      const tier = await db.pricingTier.findFirst({
        where: { id: pricingTierId, ticketTypeId },
        select: { price: true },
      });
      if (tier) originalPrice = Number(tier.price);
    }
    if (originalPrice === 0) {
      const ticket = await db.ticketType.findFirst({
        where: { id: ticketTypeId },
        select: { price: true },
      });
      if (ticket) originalPrice = Number(ticket.price);
    }

    // Calculate discount
    let discountAmount: number;
    if (promoCode.discountType === "PERCENTAGE") {
      discountAmount = originalPrice * Number(promoCode.discountValue) / 100;
    } else {
      discountAmount = Math.min(Number(promoCode.discountValue), originalPrice);
    }
    discountAmount = Math.round(discountAmount * 100) / 100;
    const finalPrice = Math.max(0, originalPrice - discountAmount);

    return NextResponse.json({
      valid: true,
      code: promoCode.code,
      discountType: promoCode.discountType,
      discountValue: Number(promoCode.discountValue),
      discountAmount,
      originalPrice,
      finalPrice,
    });
  } catch (error) {
    apiLogger.error({ error, msg: "Failed to validate promo code" });
    return NextResponse.json(
      { error: "Failed to validate promo code" },
      { status: 500 }
    );
  }
}
