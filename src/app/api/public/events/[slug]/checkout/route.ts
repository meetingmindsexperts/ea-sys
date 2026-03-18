import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getStripe } from "@/lib/stripe";
import { checkRateLimit, getClientIp } from "@/lib/security";

const checkoutSchema = z.object({
  registrationId: z.string().min(1).max(100),
});

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const clientIp = getClientIp(req);

    // Rate limit: 3 checkout attempts per 60s per IP
    const rateLimit = checkRateLimit({
      key: `checkout:${clientIp}`,
      limit: 3,
      windowMs: 60 * 1000,
    });
    if (!rateLimit.allowed) {
      apiLogger.warn({ msg: "Checkout rate limit hit", ip: clientIp });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
      );
    }

    const [{ slug }, body] = await Promise.all([params, req.json()]);
    const validated = checkoutSchema.safeParse(body);

    if (!validated.success) {
      apiLogger.warn({ msg: "Checkout validation failed", slug, errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { registrationId } = validated.data;

    // Look up registration with ticket and event details
    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        event: {
          OR: [{ slug }, { id: slug }],
          status: { in: ["PUBLISHED", "LIVE"] },
        },
        status: { not: "CANCELLED" },
      },
      include: {
        ticketType: { select: { id: true, name: true, price: true, currency: true } },
        attendee: { select: { firstName: true, lastName: true, email: true } },
        event: { select: { id: true, name: true, slug: true } },
      },
    });

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const ticketPrice = Number(registration.ticketType.price);

    if (ticketPrice === 0) {
      return NextResponse.json(
        { error: "No payment required for free tickets" },
        { status: 400 }
      );
    }

    if (registration.paymentStatus === "PAID") {
      return NextResponse.json(
        { error: "Payment already completed" },
        { status: 400 }
      );
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const eventSlug = registration.event.slug;
    const firstName = registration.attendee.firstName;

    const successUrl = `${appUrl}/e/${eventSlug}/confirmation?id=${registrationId}&name=${encodeURIComponent(firstName)}&payment=success`;
    const cancelUrl = `${appUrl}/e/${eventSlug}/confirmation?id=${registrationId}&name=${encodeURIComponent(firstName)}&payment=cancelled`;

    // Create Stripe Checkout Session
    // Note: Stripe uses smallest currency unit (cents for USD/EUR/AED).
    // Zero-decimal currencies (JPY, KRW) don't need multiplication — not handled here for MVP.
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: registration.ticketType.currency.toLowerCase(),
            product_data: {
              name: `${registration.event.name} — ${registration.ticketType.name}`,
            },
            unit_amount: Math.round(ticketPrice * 100),
          },
          quantity: 1,
        },
      ],
      customer_email: registration.attendee.email,
      metadata: {
        registrationId: registration.id,
        eventId: registration.event.id,
        eventSlug,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    // Update payment status to PENDING
    await db.registration.update({
      where: { id: registrationId },
      data: { paymentStatus: "PENDING" },
    });

    apiLogger.info({
      msg: "Stripe checkout session created",
      registrationId,
      eventId: registration.event.id,
      sessionId: session.id,
      amount: ticketPrice,
      currency: registration.ticketType.currency,
    });

    return NextResponse.json({ checkoutUrl: session.url });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating checkout session" });
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
