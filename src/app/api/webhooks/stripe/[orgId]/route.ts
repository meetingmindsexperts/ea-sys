import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { verifyWebhookSignature, getOrgStripeWebhookSecret } from "@/lib/stripe";
import { checkRateLimit, getClientIp } from "@/lib/security";
import type Stripe from "stripe";
import { handleStripeEvent } from "@/lib/stripe-webhook-handler";

/**
 * PER-ORG Stripe webhook endpoint (per-tenant Stripe keys, item 7 phase 2;
 * hardened per the Aug 4 adversarial review — HIGH-1/M2/M3/L6).
 *
 * A tenant with its own Stripe account points its Stripe Dashboard webhook at
 *   {appUrl}/api/webhooks/stripe/{orgId}
 * (displayed with a copy button in Settings → Integrations → Stripe). The org
 * id in the path solves the chicken-and-egg of webhook verification: the
 * signing secret must be known BEFORE the payload can be parsed.
 *
 * Trust model: a valid signature proves the event came from the Stripe
 * account THIS ORG registered — an account the org's own admin controls. It
 * proves nothing about other orgs, so:
 *  - metadata claiming a different org is refused up front (400), and
 *  - the shared dispatcher additionally enforces that every RESOLVED
 *    registration/payment belongs to this org (`expectedOrgId` — covers
 *    events whose metadata omits the org key entirely).
 * Livemode is cross-checked against the org's stored keyMode (M2) so a
 * test-mode webhook can't flip real registrations PAID with fake cards.
 *
 * The legacy /api/webhooks/stripe route (env secret) continues to serve
 * master/MMG; each Stripe account is configured with exactly one of the two
 * URLs, so the routes never overlap.
 */

// One generic 400 for every pre-verification refusal (secret missing, bad
// signature, livemode mismatch, foreign metadata) — an unauthenticated
// caller must not be able to distinguish an org's configuration state (L6).
function genericRefusal(): NextResponse {
  return NextResponse.json({ error: "Webhook request rejected" }, { status: 400 });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;

  // M3: this endpoint is unauthenticated and each request costs a DB read —
  // cap per-IP ahead of it. Generous (real Stripe delivery bursts are far
  // below this); nginx's global per-IP limit sits in front of it too.
  const rl = checkRateLimit({
    key: `stripe-org-webhook:${getClientIp(req)}`,
    limit: 300,
    windowMs: 60_000,
  });
  if (!rl.allowed) {
    apiLogger.warn({ msg: "stripe-org-webhook:rate-limited", orgId });
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let event: Stripe.Event;
  try {
    // Must read raw body for signature verification — do NOT use req.json()
    const body = await req.text();
    const sig = req.headers.get("stripe-signature");

    if (!sig) {
      apiLogger.warn({ msg: "stripe-org-webhook:missing-signature-header", orgId });
      return genericRefusal();
    }

    const secretInfo = await getOrgStripeWebhookSecret(orgId);
    if (!secretInfo) {
      // Unknown org and org-without-a-configured-secret both land here —
      // same response as every other refusal (no config-state oracle).
      apiLogger.warn({ msg: "stripe-org-webhook:secret-not-configured", orgId });
      return genericRefusal();
    }

    // constructEvent is static crypto — only the secret argument matters, so
    // this deliberately does NOT resolve the org's API key. It used to call
    // getStripe(orgId), which coupled signature verification to credential
    // resolution: once an org with no API key is refused (Aug 24, 2026), a
    // tenant who had saved a webhook secret but not yet a key would have had
    // its webhooks rejected as unverifiable.
    event = verifyWebhookSignature(body, sig, secretInfo.webhookSecret);

    // M2: livemode must match the org's stored key mode. A live-keyed org
    // receiving test-mode events (or vice versa) means someone pointed the
    // wrong-mode webhook here — test-mode "payments" are fake money and must
    // never flip real registrations PAID. keyMode null (no API key saved
    // yet) skips the check.
    if (
      (secretInfo.keyMode === "live" && event.livemode === false) ||
      (secretInfo.keyMode === "test" && event.livemode === true)
    ) {
      apiLogger.error({
        msg: "stripe-org-webhook:livemode-mismatch-refused",
        orgId,
        keyMode: secretInfo.keyMode,
        eventLivemode: event.livemode,
        eventType: event.type,
      });
      return genericRefusal();
    }
  } catch (err) {
    apiLogger.error({ err, orgId, msg: "stripe-org-webhook:signature-verification-failed" });
    return genericRefusal();
  }

  // HIGH-1 (first layer): metadata claiming a different org is refused up
  // front. The dispatcher's expectedOrgId enforcement below is the real
  // guard (metadata can simply be omitted); this is the cheap early exit.
  const objectMeta = (event.data.object as { metadata?: Record<string, string> }).metadata;
  if (objectMeta?.organizationId && objectMeta.organizationId !== orgId) {
    apiLogger.error({
      msg: "stripe-org-webhook:metadata-org-mismatch-refused",
      orgId,
      metadataOrganizationId: objectMeta.organizationId,
      eventType: event.type,
    });
    return genericRefusal();
  }

  return handleStripeEvent(event, { expectedOrgId: orgId });
}
