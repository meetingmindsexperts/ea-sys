import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ slug: string; registrationId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, registrationId } = await params;

    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        event: {
          OR: [{ slug }, { id: slug }],
        },
      },
      select: {
        status: true,
        paymentStatus: true,
        discountAmount: true,
        originalPrice: true,
        event: {
          select: {
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

    const basePrice = Number(registration.pricingTier?.price ?? registration.ticketType?.price ?? 0);
    const discount = registration.discountAmount ? Number(registration.discountAmount) : 0;

    const response = NextResponse.json({
      registrationStatus: registration.status,
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
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching payment status" });
    return NextResponse.json(
      { error: "Failed to fetch payment status" },
      { status: 500 }
    );
  }
}
