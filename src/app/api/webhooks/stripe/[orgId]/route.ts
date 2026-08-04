import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { getStripe, getOrgStripeWebhookSecret } from "@/lib/stripe";
import type Stripe from "stripe";
import { handleStripeEvent } from "@/lib/stripe-webhook-handler";

/**
 * PER-ORG Stripe webhook endpoint (per-tenant Stripe keys, item 7 phase 2).
 *
 * A tenant with its own Stripe account points its Stripe Dashboard webhook at
 *   {appUrl}/api/webhooks/stripe/{orgId}
 * (the URL is displayed with a copy button in Settings → Integrations →
 * Stripe). The org id in the path solves the chicken-and-egg of webhook
 * verification: the signing secret must be known BEFORE the payload can be
 * parsed, and a Stripe event carries no org identity until it's verified.
 *
 * Verification uses the org's encrypted webhookSecret from
 * Organization.settings.stripe; everything after a verified event delegates
 * to the SAME shared dispatcher as the legacy env route — one implementation,
 * zero drift. The legacy /api/webhooks/stripe route (env secret) continues to
 * serve master/MMG; each Stripe account is configured with exactly one of the
 * two URLs, so the routes never overlap.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;

  let event: Stripe.Event;
  try {
    // Must read raw body for signature verification — do NOT use req.json()
    const body = await req.text();
    const sig = req.headers.get("stripe-signature");

    if (!sig) {
      apiLogger.warn({ msg: "stripe-org-webhook:missing-signature-header", orgId });
      return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
    }

    // Unknown org and org-without-a-configured-secret both return the SAME
    // generic 400 — this endpoint is unauthenticated, so it must not act as
    // an org-id existence oracle.
    const webhookSecret = await getOrgStripeWebhookSecret(orgId);
    if (!webhookSecret) {
      apiLogger.warn({ msg: "stripe-org-webhook:secret-not-configured", orgId });
      return NextResponse.json({ error: "Webhook not configured" }, { status: 400 });
    }

    // constructEvent is static crypto — only the secret argument matters.
    // getStripe(orgId) is the natural client here and falls back to env when
    // the org has a webhook secret but no API key saved yet.
    const stripe = await getStripe(orgId);
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    apiLogger.error({ err, orgId, msg: "stripe-org-webhook:signature-verification-failed" });
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Defense-in-depth observability, NOT a rejection: the signature already
  // proved the event comes from the account this org registered. A metadata
  // org mismatch (e.g. a checkout session minted while the event belonged to
  // a different org) is logged so cross-wiring is visible in /logs; the
  // shared handler still resolves the true org from metadata/payment lookups.
  const objectMeta = (event.data.object as { metadata?: Record<string, string> }).metadata;
  if (objectMeta?.organizationId && objectMeta.organizationId !== orgId) {
    apiLogger.warn({
      msg: "stripe-org-webhook:metadata-org-mismatch",
      orgId,
      metadataOrganizationId: objectMeta.organizationId,
      eventType: event.type,
    });
  }

  return handleStripeEvent(event);
}
