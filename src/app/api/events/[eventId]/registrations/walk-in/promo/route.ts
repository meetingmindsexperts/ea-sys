import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { runWithTenant } from "@/lib/tenant-context";
import { PROMO_REFUSAL_MESSAGE, promoDiscount, promoRefusal, promoSponsorCovers, type PromoRefusal } from "@/lib/promo-redeem";

/**
 * GET /api/events/[eventId]/registrations/walk-in/promo?code=&ticketTypeId=&pricingTierId=&sponsor=1&email=
 *
 * The desk checks a walk-in's code before taking money (Oct 29, 2026), so the
 * operator sees what to collect, or which sponsor pays. Read-only: the same
 * rules the walk-in's redemption applies (promo-redeem.ts); the usage and
 * per-email limits are read as they stand, and decided for real when the
 * walk-in is created.
 */

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const ROUTE = "events/[eventId]/registrations/walk-in/promo:GET";

const querySchema = z.object({
  code: z.string().trim().min(1).max(50),
  ticketTypeId: z.string().min(1),
  pricingTierId: z.string().min(1).optional(),
  sponsor: z.enum(["1"]).optional(),
  email: z.string().trim().email().max(255).optional(),
});

export async function GET(req: Request, { params }: RouteParams) {
  const { eventId } = await params;
  try {
    const session = await auth();
    if (!session?.user) {
      apiLogger.warn({ msg: "walk-in-promo:unauthenticated", eventId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE, eventId });
    if ("error" in orgGuard) return orgGuard.error;

    // Whoever may register the walk-in may check the code they bring.
    const gate = requirePermission(session, "registrations.create", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    // A code check per walk-in, sometimes two; this stops guessing codes in bulk.
    const rateLimit = checkRateLimit({ key: `walk-in-promo:${session.user.id}`, limit: 300, windowMs: 60 * 60 * 1000 });
    if (!rateLimit.allowed) {
      return rateLimited(rateLimit, { route: ROUTE, userId: session.user.id, eventId, limit: 300, windowSeconds: 3600 });
    }

    const query = Object.fromEntries(new URL(req.url).searchParams);
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) {
      apiLogger.warn({ msg: "walk-in-promo:invalid-query", eventId, userId: session.user.id, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const { code, ticketTypeId, pricingTierId, sponsor, email } = parsed.data;

    return await runWithTenant(orgGuard.orgId, async () => {
      const [event, ticketType, promo] = await Promise.all([
        db.event.findFirst({ where: gate.eventWhere, select: { id: true } }),
        db.ticketType.findFirst({
          where: { id: ticketTypeId, eventId },
          select: { price: true, pricingTiers: { where: { id: pricingTierId ?? "" }, select: { price: true } } },
        }),
        db.promoCode.findUnique({
          where: { eventId_code: { eventId, code: code.toUpperCase() } },
          include: { ticketTypes: { select: { ticketTypeId: true } }, sponsor: { select: { name: true } } },
        }),
      ]);
      if (!event) {
        apiLogger.warn({ msg: "walk-in-promo:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      if (!ticketType) {
        apiLogger.warn({ msg: "walk-in-promo:ticket-type-not-found", eventId, ticketTypeId, userId: session.user.id });
        return NextResponse.json({ error: "Registration type not found", code: "TICKET_TYPE_NOT_FOUND" }, { status: 404 });
      }

      let refusal: PromoRefusal | null = promoRefusal(promo, { now: new Date(), ticketTypeId, requireSponsorCover: !!sponsor });
      if (!refusal && promo && promo.maxUses !== null && promo.usedCount >= promo.maxUses) refusal = "PROMO_CODE_EXHAUSTED";
      if (!refusal && promo && email && promo.maxUsesPerEmail !== null) {
        const uses = await db.promoCodeRedemption.count({ where: { promoCodeId: promo.id, email: email.toLowerCase() } });
        if (uses >= promo.maxUsesPerEmail) refusal = "PROMO_CODE_EMAIL_LIMIT";
      }

      const originalPrice = Number(ticketType.pricingTiers[0]?.price ?? ticketType.price ?? 0);
      const priced = promo && !refusal ? promoDiscount(promo, originalPrice) : null;
      if (sponsor && priced && promo && !promoSponsorCovers(promo, priced.finalPrice)) refusal = "PROMO_CODE_NOT_SPONSOR";
      if (refusal || !promo || !priced) {
        // A normal desk answer, not a failure: the operator reads it and asks again.
        apiLogger.info({ msg: "walk-in-promo:refused", eventId, code: refusal, userId: session.user.id });
        return NextResponse.json({ valid: false, code: refusal, error: PROMO_REFUSAL_MESSAGE[refusal ?? "INVALID_PROMO_CODE"] });
      }

      return NextResponse.json({
        valid: true,
        code: promo.code,
        discountType: promo.discountType,
        discountValue: Number(promo.discountValue),
        originalPrice,
        discountAmount: priced.discountAmount,
        finalPrice: priced.finalPrice,
        sponsorName: promoSponsorCovers(promo, priced.finalPrice) ? (promo.sponsor?.name ?? null) : null,
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "walk-in-promo:failed", eventId });
    return NextResponse.json({ error: "Failed to check the code" }, { status: 500 });
  }
}
