import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { encryptSecret } from "@/lib/eventsair-client";
import { checkRateLimit } from "@/lib/security";
import { updateOrganizationSettings } from "@/lib/event-settings";
import { invalidateStripeClientCache } from "@/lib/stripe";
import { z } from "zod";
import type { Session } from "next-auth";

/**
 * Per-org Stripe credentials (Platform decision item 7 — the Zoom
 * credentials-route pattern). Storage: `Organization.settings.stripe`
 *   { secretKeyEncrypted, secretKeyLast4, keyMode, webhookSecretEncrypted?, configuredAt }
 * Secrets are stored AES-256-GCM-encrypted and NEVER returned by GET —
 * only booleans + the plain last4/keyMode recognition hints.
 *
 * Consumed by getStripe(orgId) (src/lib/stripe.ts, org key → env fallback)
 * and the per-org webhook route /api/webhooks/stripe/[orgId].
 */

const credentialsSchema = z.object({
  // Both optional on update — blank keeps the existing encrypted value.
  // The PUT handler requires secretKey on FIRST-TIME setup.
  secretKey: z.string().max(500).optional(),
  webhookSecret: z.string().max(500).optional(),
});

function requireAdmin(session: Session | null) {
  if (!session?.user?.organizationId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "SUPER_ADMIN" && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

function readStripeSub(settings: unknown): Record<string, unknown> {
  const s = (settings as Record<string, unknown> | null) || {};
  return typeof s.stripe === "object" && s.stripe !== null
    ? (s.stripe as Record<string, unknown>)
    : {};
}

function keyModeOf(secretKey: string): "live" | "test" {
  return secretKey.startsWith("sk_live_") ? "live" : "test";
}

export async function GET() {
  try {
    const session = await auth();
    const denied = requireAdmin(session);
    if (denied) return denied;
    const orgId = session!.user.organizationId!;

    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    const stripe = readStripeSub(org?.settings);

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "";
    return NextResponse.json({
      configured: !!stripe.secretKeyEncrypted,
      hasSecretKey: !!stripe.secretKeyEncrypted,
      hasWebhookSecret: !!stripe.webhookSecretEncrypted,
      secretKeyLast4: stripe.secretKeyLast4 || null,
      keyMode: stripe.keyMode || null,
      configuredAt: stripe.configuredAt || null,
      // The URL this org pastes into its Stripe Dashboard → Webhooks.
      webhookUrl: `${appUrl}/api/webhooks/stripe/${orgId}`,
    });
  } catch (error) {
    apiLogger.error({ err: error }, "stripe:credentials-fetch-failed");
    return NextResponse.json({ error: "Failed to fetch credentials" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json()]);
    const denied = requireAdmin(session);
    if (denied) return denied;
    const orgId = session!.user.organizationId!;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `stripe-creds:${orgId}`,
      limit: 10,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: session!.user.id }, "stripe:credentials-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = credentialsSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "stripe:credentials-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    const existing = readStripeSub(org?.settings);

    // First-time setup must carry the secret key — a webhook secret alone
    // has nothing to verify against a Stripe account we can't call.
    if (!existing.secretKeyEncrypted && !validated.data.secretKey) {
      apiLogger.warn({ userId: session!.user.id }, "stripe:credentials-first-save-missing-secret-key");
      return NextResponse.json(
        { error: "The Stripe secret key is required on first setup" },
        { status: 400 },
      );
    }

    const stripeData: Record<string, unknown> = {
      ...existing,
      configuredAt: new Date().toISOString(),
    };
    // Blank keeps existing (the Zoom convention); truthy re-encrypts +
    // refreshes the plain recognition hints.
    if (validated.data.secretKey) {
      stripeData.secretKeyEncrypted = encryptSecret(validated.data.secretKey);
      stripeData.secretKeyLast4 = validated.data.secretKey.slice(-4);
      stripeData.keyMode = keyModeOf(validated.data.secretKey);
    }
    if (validated.data.webhookSecret) {
      stripeData.webhookSecretEncrypted = encryptSecret(validated.data.webhookSecret);
    }

    const clean = JSON.parse(JSON.stringify(stripeData));
    await updateOrganizationSettings(orgId, { stripe: clean });

    // Same-process immediacy; other processes converge within the 5-min TTL.
    invalidateStripeClientCache(orgId);

    // Review L5: a Stripe key swap redirects MONEY — unlike the Zoom/EventsAir
    // siblings this write earns an AuditLog row (fire-and-forget; never keys).
    db.auditLog
      .create({
        data: {
          organizationId: orgId,
          userId: session!.user.id,
          action: "UPDATE",
          entityType: "OrganizationStripeCredentials",
          entityId: orgId,
          changes: {
            savedSecretKey: !!validated.data.secretKey,
            savedWebhookSecret: !!validated.data.webhookSecret,
            keyMode: (clean.keyMode as string) ?? null,
            secretKeyLast4: (clean.secretKeyLast4 as string) ?? null,
          },
        },
      })
      .catch((err) => apiLogger.warn({ err }, "stripe:credentials-audit-failed"));

    apiLogger.info({ userId: session!.user.id }, "stripe:credentials-saved");
    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error }, "stripe:credentials-save-failed");
    return NextResponse.json({ error: "Failed to save credentials" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = await auth();
    const denied = requireAdmin(session);
    if (denied) return denied;
    const orgId = session!.user.organizationId!;

    await updateOrganizationSettings(orgId, (cur) => {
      const next = { ...cur };
      delete next.stripe;
      return next;
    });
    invalidateStripeClientCache(orgId);

    db.auditLog
      .create({
        data: {
          organizationId: orgId,
          userId: session!.user.id,
          action: "DELETE",
          entityType: "OrganizationStripeCredentials",
          entityId: orgId,
          changes: { removed: true },
        },
      })
      .catch((err) => apiLogger.warn({ err }, "stripe:credentials-audit-failed"));

    apiLogger.info({ userId: session!.user.id }, "stripe:credentials-deleted");
    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error }, "stripe:credentials-delete-failed");
    return NextResponse.json({ error: "Failed to delete credentials" }, { status: 500 });
  }
}
