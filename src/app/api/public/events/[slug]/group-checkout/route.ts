import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveTenantOrg, normalizeHost } from "@/lib/tenant/resolver";
import { getStripe, isZeroDecimalCurrency } from "@/lib/stripe";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { buildGroupLineItems } from "@/lib/invoice-service";
import { round2 } from "@/lib/registration-financials";

/**
 * Group card payment (group registration Phase 2).
 *
 * ONE Stripe checkout session settling the whole company's consolidated
 * invoice — deliberately NOT N per-member sessions: the group model's premise
 * is one payer, one total, one document, and per-member charges would produce
 * partial settlements the consolidated invoice can't represent.
 *
 * The individual `checkout` route refuses a group member outright
 * (`COVERED_BY_GROUP`), so this is the only card path into a group's money.
 *
 * The amount charged is the INVOICE's frozen snapshot, never a fresh
 * computation, so the card statement, the PDF and the AR ledger can never
 * disagree about what the company owed.
 */

const groupCheckoutSchema = z.object({
  groupId: z.string().min(1).max(100),
});

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const clientIp = getClientIp(req);

    // Mirrors the single-registration checkout limit: a company rep behind a
    // shared corporate NAT must not be blocked by a colleague's attempt.
    const rateLimit = checkRateLimit({
      key: `group-checkout:${clientIp}`,
      limit: 15,
      windowMs: 60 * 1000,
    });
    if (!rateLimit.allowed) {
      apiLogger.warn({ msg: "group-checkout:rate-limited", ip: clientIp });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
      );
    }

    const [{ slug }, body] = await Promise.all([params, req.json()]);
    const validated = groupCheckoutSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({
        msg: "group-checkout:invalid-input",
        slug,
        errors: validated.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 },
      );
    }

    const { groupId } = validated.data;

    const tenant = await resolveTenantOrg(normalizeHost(req.headers.get("host")));
    return await runWithTenant(tenant.orgId ?? "", async () => {
      const group = await db.registrationGroup.findFirst({
        where: {
          id: groupId,
          event: await publicEventWhere(req, slug, {
            allowIdFallback: true,
            statuses: ["PUBLISHED", "LIVE"],
          }),
        },
        include: {
          event: {
            select: {
              id: true,
              name: true,
              slug: true,
              organizationId: true,
              taxRate: true,
              taxLabel: true,
            },
          },
          billingAccount: { select: { name: true, email: true } },
          registrations: {
            // Cancelled members are loaded (not filtered) so the Stripe page
            // can show the SAME per-person lines as the consolidated invoice,
            // which keeps them for the total it was issued at.
            select: {
              id: true,
              status: true,
              paymentStatus: true,
              originalPrice: true,
              ticketType: { select: { name: true, currency: true } },
              pricingTier: { select: { name: true, currency: true } },
              attendee: { select: { title: true, firstName: true, lastName: true } },
            },
          },
        },
      });

      if (!group) {
        apiLogger.warn({ msg: "group-checkout:group-not-found", slug, groupId });
        return NextResponse.json({ error: "Group registration not found" }, { status: 404 });
      }

      const liveMembers = group.registrations.filter((r) => r.status !== "CANCELLED");
      const payableMembers = liveMembers.filter(
        (r) => r.paymentStatus === "UNPAID" || r.paymentStatus === "PENDING",
      );
      if (payableMembers.length === 0) {
        apiLogger.warn({
          msg: "group-checkout:nothing-due",
          groupId,
          memberCount: liveMembers.length,
        });
        return NextResponse.json(
          { error: "This group registration has already been settled.", code: "ALREADY_SETTLED" },
          { status: 400 },
        );
      }

      // The open consolidated invoice is the authoritative amount owed. It is
      // a frozen snapshot taken at group create, so charging it (rather than
      // recomputing from live members) keeps the card charge, the PDF and the
      // ledger in agreement even if a member was cancelled since.
      const invoice = await db.invoice.findFirst({
        where: {
          groupId: group.id,
          eventId: group.event.id,
          type: "INVOICE",
          status: { notIn: ["CANCELLED", "PAID"] },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, subtotal: true, taxAmount: true, total: true, currency: true },
      });

      const memberCurrency =
        liveMembers[0]?.pricingTier?.currency ??
        liveMembers[0]?.ticketType?.currency ??
        "USD";

      const subtotal = invoice
        ? Number(invoice.subtotal)
        : round2(liveMembers.reduce((s, r) => s + Number(r.originalPrice ?? 0), 0));
      const taxRate = group.event.taxRate ? Number(group.event.taxRate) : 0;
      const taxAmount = invoice ? Number(invoice.taxAmount) : round2(subtotal * (taxRate / 100));
      const total = invoice ? Number(invoice.total) : round2(subtotal + taxAmount);
      const currency = (invoice?.currency ?? memberCurrency).toLowerCase();

      if (total <= 0) {
        apiLogger.warn({ msg: "group-checkout:zero-total", groupId, subtotal, total });
        return NextResponse.json(
          { error: "No payment is required for this group registration." },
          { status: 400 },
        );
      }

      const toStripe = (v: number) =>
        isZeroDecimalCurrency(currency) ? Math.round(v) : Math.round(v * 100);

      // Named per-person lines, matching the consolidated invoice exactly (the
      // same builder feeds both). Shown only while they still sum to the
      // amount being charged — a payment page whose items don't add up to its
      // own total is worse than one honest line, so fall back rather than
      // mislead.
      const derived = buildGroupLineItems(group.registrations);
      const derivedSum = round2(derived.reduce((s, li) => s + li.amount, 0));
      const linesAgree = Math.abs(derivedSum - subtotal) < 0.005;

      const lineItems = (
        linesAgree
          ? derived.map((li) => ({
              name: `${group.event.name} — ${li.description}`,
              unit_amount: toStripe(round2(li.amount)),
            }))
          : [
              {
                name: `${group.event.name} — group registration (${liveMembers.length} attendees)`,
                unit_amount: toStripe(subtotal),
              },
            ]
      ).map((l) => ({
        price_data: {
          currency,
          product_data: { name: l.name },
          unit_amount: l.unit_amount,
        },
        quantity: 1,
      }));

      if (taxAmount > 0) {
        lineItems.push({
          price_data: {
            currency,
            product_data: { name: `${group.event.taxLabel || "VAT"} (${taxRate}%)` },
            unit_amount: toStripe(taxAmount),
          },
          quantity: 1,
        });
      }

      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
      const returnBase = `${appUrl}/e/${group.event.slug}/group/register?group=${group.id}`;

      const stripe = await getStripe(group.event.organizationId);
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: lineItems,
        // The COMPANY pays, so the receipt goes to the payer's billing contact
        // when there is one — falling back to the coordinator who is running
        // the registration.
        customer_email: group.billingAccount.email || group.coordinatorEmail,
        metadata: {
          groupId: group.id,
          eventId: group.event.id,
          eventSlug: group.event.slug,
          // Carried so the unauthenticated webhook can open the tenant store
          // before reading any swept table (same contract as the single
          // registration checkout).
          organizationId: group.event.organizationId,
        },
        success_url: `${returnBase}&payment=success`,
        cancel_url: `${returnBase}&payment=cancelled`,
      });

      // Conditional claim on the SAME statuses the payable filter used: a
      // concurrent settlement (a second open tab, or a bank transfer recorded
      // by the desk) must not be demoted back to PENDING.
      const claimed = await db.registration.updateMany({
        where: {
          groupId: group.id,
          status: { not: "CANCELLED" },
          paymentStatus: { in: ["UNPAID", "PENDING"] },
        },
        data: { paymentStatus: "PENDING", stripeCheckoutSessionId: session.id },
      });

      if (claimed.count === 0) {
        await stripe.checkout.sessions
          .expire(session.id)
          .catch((err) =>
            apiLogger.error({
              err,
              msg: "group-checkout:failed-to-expire-stale-session",
              groupId,
              sessionId: session.id,
            }),
          );
        apiLogger.warn({
          msg: "group-checkout:lost-race-to-settlement — session expired",
          groupId,
          sessionId: session.id,
        });
        return NextResponse.json(
          { error: "This group registration has already been settled.", code: "ALREADY_SETTLED" },
          { status: 400 },
        );
      }

      apiLogger.info({
        msg: "group-checkout:session-created",
        groupId,
        eventId: group.event.id,
        sessionId: session.id,
        memberCount: group.registrations.length,
        claimedMembers: claimed.count,
        subtotal,
        taxAmount,
        total,
        currency,
        invoiceId: invoice?.id ?? null,
        descriptiveLines: linesAgree,
      });

      return NextResponse.json({ checkoutUrl: session.url });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "group-checkout:failed" });
    return NextResponse.json({ error: "Failed to create checkout session" }, { status: 500 });
  }
}
