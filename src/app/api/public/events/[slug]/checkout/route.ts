import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveTenantOrg, normalizeHost } from "@/lib/tenant/resolver";
import { getStripe, isZeroDecimalCurrency, StripeCredentialsMissingError } from "@/lib/stripe";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { readRegistrationBasePrice } from "@/lib/registration-financials";
import { NO_PAYMENT_DUE_STATUSES } from "@/app/(dashboard)/events/[eventId]/registrations/registration-enums";

// Statuses where no money is due from the attendee (PAID / COMPLIMENTARY /
// INCLUSIVE / REFUNDED). INCLUSIVE means a sponsor already paid offline —
// charging the attendee here would collect the money twice; REFUNDED means
// re-payment needs organizer involvement, not a self-service card charge.
const NO_PAYMENT_DUE_MESSAGES: Partial<Record<string, string>> = {
  PAID: "Payment already completed",
  COMPLIMENTARY: "Payment already completed",
  INCLUSIVE: "This registration is sponsor-paid — no payment is due.",
  REFUNDED: "This registration was refunded. Please contact the organizer to arrange re-payment.",
};

const checkoutSchema = z.object({
  registrationId: z.string().min(1).max(100),
});

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const clientIp = getClientIp(req);

    // Rate limit: 15 checkout attempts per 60s per IP. Raised from 3 so multiple
    // genuine payers behind one shared NAT (hospital/office) aren't blocked;
    // still caps a single source hammering Stripe session creation.
    const rateLimit = checkRateLimit({
      key: `checkout:${clientIp}`,
      limit: 15,
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

    // Tenancy sweep: resolve the tenant org from the request host BEFORE the
    // swept registration read (else it fail-closes on the platform). Passthrough
    // on master; publicEventWhere still enforces the event/tenant match below.
    const tenant = await resolveTenantOrg(normalizeHost(req.headers.get("host")));
    return await runWithTenant(tenant.orgId ?? "", async () => {
    // Look up registration with ticket and event details (event tenant-scoped)
    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        event: await publicEventWhere(req, slug, {
          allowIdFallback: true,
          statuses: ["PUBLISHED", "LIVE"],
        }),
        status: { not: "CANCELLED" },
      },
      include: {
        ticketType: { select: { id: true, name: true, price: true, currency: true } },
        pricingTier: { select: { id: true, price: true, currency: true } },
        attendee: { select: { firstName: true, lastName: true, email: true } },
        event: { select: { id: true, name: true, slug: true, organizationId: true, taxRate: true, taxLabel: true } },
        promoCode: { select: { code: true } },
      },
    });

    if (!registration) {
      apiLogger.warn({ msg: "Checkout: registration not found", slug, registrationId });
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    if (!registration.ticketType) {
      // Reachable for an uncategorised row (e.g. a CSV import whose file had no
      // registrationType and no fallback was picked). Nothing is priced, so
      // there is nothing to charge — same outcome as the free-ticket branch
      // below. Logged because it was previously a silent 400.
      apiLogger.warn({ msg: "Checkout attempted for a registration with no ticket type", registrationId });
      return NextResponse.json({ error: "Registration has no ticket type" }, { status: 400 });
    }

    const basePrice = readRegistrationBasePrice(registration);
    const discountAmount = registration.discountAmount ? Number(registration.discountAmount) : 0;
    const ticketPrice = Math.max(0, basePrice - discountAmount);

    if (ticketPrice === 0) {
      apiLogger.warn({ msg: "Checkout attempted for free ticket", registrationId });
      return NextResponse.json(
        { error: "No payment required for free tickets" },
        { status: 400 }
      );
    }

    if (NO_PAYMENT_DUE_STATUSES.includes(registration.paymentStatus)) {
      apiLogger.warn({
        msg: "Checkout attempted for a no-payment-due registration",
        registrationId,
        paymentStatus: registration.paymentStatus,
      });
      return NextResponse.json(
        { error: NO_PAYMENT_DUE_MESSAGES[registration.paymentStatus] ?? "Payment already completed" },
        { status: 400 }
      );
    }

    // Group-registration gate (review H1): a group member's fee is owed by the
    // COMPANY via the consolidated invoice — an individual card payment here
    // would double-collect (the webhook would also mint an individual PAID
    // invoice conflicting with the group one). Mirrors the INCLUSIVE gate.
    if (registration.groupId) {
      apiLogger.warn({ msg: "Checkout attempted for a group-covered registration", registrationId });
      return NextResponse.json(
        {
          error: "This registration is part of a group registration — the fee is billed to the company on the consolidated invoice. No individual payment is due.",
          code: "COVERED_BY_GROUP",
        },
        { status: 400 },
      );
    }

    // Calculate tax from event settings
    const taxRate = Number(registration.event.taxRate || 0);
    const taxLabel = registration.event.taxLabel || "VAT";
    const taxAmount = ticketPrice * taxRate / 100;
    const total = ticketPrice + taxAmount;

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const eventSlug = registration.event.slug;
    const firstName = registration.attendee.firstName;

    const successUrl = `${appUrl}/e/${eventSlug}/confirmation?id=${registrationId}&name=${encodeURIComponent(firstName)}&payment=success`;
    const cancelUrl = `${appUrl}/e/${eventSlug}/confirmation?id=${registrationId}&name=${encodeURIComponent(firstName)}&payment=cancelled`;

    // Create Stripe Checkout Session
    const currencyCode = (registration.pricingTier?.currency ?? registration.ticketType.currency).toLowerCase();
    const ticketUnitAmount = isZeroDecimalCurrency(currencyCode)
      ? Math.round(ticketPrice)
      : Math.round(ticketPrice * 100);
    const taxUnitAmount = isZeroDecimalCurrency(currencyCode)
      ? Math.round(taxAmount)
      : Math.round(taxAmount * 100);

    const lineItems: {
      price_data: {
        currency: string;
        product_data: { name: string };
        unit_amount: number;
      };
      quantity: number;
    }[] = [
      {
        price_data: {
          currency: currencyCode,
          product_data: {
            name: `${registration.event.name} — ${registration.ticketType.name}`,
          },
          unit_amount: ticketUnitAmount,
        },
        quantity: 1,
      },
    ];

    if (taxAmount > 0) {
      lineItems.push({
        price_data: {
          currency: currencyCode,
          product_data: {
            name: `${taxLabel} (${taxRate}%)`,
          },
          unit_amount: taxUnitAmount,
        },
        quantity: 1,
      });
    }

    // Per-org Stripe: the event's org key when configured, env fallback.
    const stripe = await getStripe(registration.event.organizationId);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      customer_email: registration.attendee.email,
      metadata: {
        registrationId: registration.id,
        eventId: registration.event.id,
        eventSlug,
        // Tenancy sweep (H-1): carry the org so the Stripe webhook can open its
        // tenant store BEFORE reading the swept Registration (the webhook is
        // unauthenticated — no session/host to resolve the org from).
        organizationId: registration.event.organizationId,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    // Move to PENDING via a conditional claim, NOT an unconditional update.
    // The no-payment-due guard above ran on a read taken BEFORE the slow
    // Stripe call — a concurrent tab's payment can have settled this
    // registration in the meantime, and a blind write here would demote a
    // PAID row to PENDING (and later, via checkout.session.expired, to
    // UNPAID — re-opening the pay path on a paid registration).
    const claimed = await db.registration.updateMany({
      where: {
        id: registrationId,
        paymentStatus: { notIn: [...NO_PAYMENT_DUE_STATUSES] },
      },
      // Session id stored so a later CANCEL can expire the open payment tab
      // (review H2 sub-item); cleared on completion/expiry by the webhook.
      data: { paymentStatus: "PENDING", stripeCheckoutSessionId: session.id },
    });
    if (claimed.count === 0) {
      // Settled while we were creating the session — void the just-created
      // session so the stale payment link can't be completed later.
      await stripe.checkout.sessions
        .expire(session.id)
        .catch((err) => apiLogger.error({ err, msg: "Failed to expire stale checkout session", registrationId, sessionId: session.id }));
      apiLogger.warn({
        msg: "Checkout lost race to a concurrent settlement — session expired",
        registrationId,
        sessionId: session.id,
      });
      return NextResponse.json({ error: "Payment already completed" }, { status: 400 });
    }

    apiLogger.info({
      msg: "Stripe checkout session created",
      registrationId,
      eventId: registration.event.id,
      sessionId: session.id,
      amount: ticketPrice,
      taxRate,
      taxAmount,
      total,
      currency: registration.pricingTier?.currency ?? registration.ticketType.currency,
    });

    return NextResponse.json({ checkoutUrl: session.url });
    });
  } catch (error) {
    // A tenant with no Stripe key is an OPERATOR problem, not a registrant
    // one: 503 + an honest message beats a bare 500 that reads as our outage,
    // and the org id is already error-logged by getStripe so the alert names
    // who has to act.
    if (error instanceof StripeCredentialsMissingError) {
      return NextResponse.json(
        {
          error:
            "Online payment is not available for this event yet. Please contact the organizer.",
          code: error.code,
        },
        { status: 503 },
      );
    }
    apiLogger.error({ err: error, msg: "Error creating checkout session" });
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
