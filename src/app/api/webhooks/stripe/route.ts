import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { verifyWebhookSignature } from "@/lib/stripe";
import type Stripe from "stripe";
import { handleStripeEvent } from "@/lib/stripe-webhook-handler";

/**
 * LEGACY / env-scoped Stripe webhook endpoint (master + MMG).
 *
 * Verifies the signature against the env STRIPE_WEBHOOK_SECRET, then
 * delegates every event to the SHARED dispatcher in
 * src/lib/stripe-webhook-handler.ts. Tenants with their own Stripe account
 * use the per-org endpoint /api/webhooks/stripe/[orgId] instead — each
 * Stripe account's dashboard points at exactly one of the two URLs, so the
 * routes never overlap.
 */
export async function POST(req: Request) {
  let event: Stripe.Event;

  try {
    // Must read raw body for signature verification — do NOT use req.json()
    const body = await req.text();
    const sig = req.headers.get("stripe-signature");

    if (!sig) {
      apiLogger.warn({ msg: "Stripe webhook missing signature header" });
      return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      apiLogger.error({ msg: "STRIPE_WEBHOOK_SECRET not configured" });
      return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
    }

    // constructEvent is static crypto — only the secret argument matters. This
    // route is env-scoped (master / MM Group), but verifying a signature has no
    // business depending on whether an API key is resolvable, so it uses the
    // key-less verifier like its per-org sibling.
    event = verifyWebhookSignature(body, sig, webhookSecret);
  } catch (err) {
    apiLogger.error({ err, msg: "Stripe webhook signature verification failed" });
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  return handleStripeEvent(event);
}
