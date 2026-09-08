import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { rateLimited } from "@/lib/api-errors";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { publicEventWhere } from "@/lib/public-event";
import { readRegistrationBasePrice } from "@/lib/registration-financials";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveTenantOrg, normalizeHost } from "@/lib/tenant/resolver";

interface RouteParams {
  params: Promise<{ slug: string; registrationId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, registrationId } = await params;

    // Review Sep 8, 2026 (P1b): this route had no throttle at all, so a leaked
    // registration id was a durable, unthrottled payment-status oracle. The
    // confirmation page polls at most 8 times per load; 120 per 15 min per IP
    // bounds the oracle without blocking a venue NAT where a dozen
    // self-registrants poll at once. The id-as-credential itself is the
    // scheduled document-token change (ROADMAP).
    const rl = checkRateLimit({
      key: `public-payment-status:${getClientIp(req)}`,
      limit: 120,
      windowMs: 15 * 60 * 1000,
    });
    if (!rl.allowed) {
      return rateLimited(rl, {
        route: "public/payment-status",
        slug,
        registrationId,
        limit: 120,
        windowSeconds: 900,
      });
    }

    // Tenancy sweep: open the tenant store BEFORE the swept Registration read
    // (resolved from the request HOST — this route reads no un-swept Event
    // first). Passthrough on master (host unresolved → orgId "" → no SET LOCAL).
    const tenant = await resolveTenantOrg(normalizeHost(req.headers.get("host")));
    return await runWithTenant(tenant.orgId ?? "", async () => {
    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        event: await publicEventWhere(req, slug, { allowIdFallback: true }),
      },
      select: {
        status: true,
        serialId: true,
        paymentStatus: true,
        discountAmount: true,
        originalPrice: true,
        event: {
          select: {
            organizationId: true,
            taxRate: true,
            taxLabel: true,
          },
        },
        ticketType: {
          select: {
            name: true,
            price: true,
            currency: true,
          },
        },
        pricingTier: {
          select: {
            price: true,
            currency: true,
          },
        },
        promoCode: {
          select: { code: true },
        },
      },
    });

    if (!registration) {
      apiLogger.warn({ msg: "Payment status: registration not found", slug, registrationId });
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const basePrice = readRegistrationBasePrice(registration);
    const discount = registration.discountAmount ? Number(registration.discountAmount) : 0;

    const response = NextResponse.json({
      registrationStatus: registration.status,
      serialId: registration.serialId,
      paymentStatus: registration.paymentStatus,
      ticketName: registration.ticketType?.name ?? "General",
      ticketPrice: Math.max(0, basePrice - discount),
      ticketCurrency: registration.pricingTier?.currency ?? registration.ticketType?.currency ?? "USD",
      taxRate: registration.event.taxRate ? Number(registration.event.taxRate) : null,
      taxLabel: registration.event.taxLabel,
      originalPrice: registration.originalPrice ? Number(registration.originalPrice) : null,
      discountAmount: discount > 0 ? discount : null,
      promoCode: registration.promoCode?.code || null,
    });

    // Short cache to allow polling but reduce DB load
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=5");
    return response;
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching payment status" });
    return NextResponse.json(
      { error: "Failed to fetch payment status" },
      { status: 500 }
    );
  }
}
