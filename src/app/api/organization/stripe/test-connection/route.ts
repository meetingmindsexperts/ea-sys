import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { db } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

/**
 * Probe the EFFECTIVE Stripe client for this org — the same resolution chain
 * production uses (org key → env fallback) — with one cheap read-only call.
 * `source` tells the admin which lane answered (org vs env), so "it works"
 * can't silently mean "the env fallback works while my org key is broken".
 */
export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (session.user.role !== "SUPER_ADMIN" && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const orgId = session.user.organizationId;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `stripe-test:${orgId}`,
      limit: 10,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: session.user.id }, "stripe:test-connection-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    const settings = (org?.settings as Record<string, unknown> | null) || {};
    const stripeSub = settings.stripe as Record<string, unknown> | undefined;
    const source: "org" | "env" = stripeSub?.secretKeyEncrypted ? "org" : "env";

    const stripe = await getStripe(orgId);
    const account = await stripe.accounts.retrieve();

    // Review L4: account identity is returned ONLY for the org's own key —
    // the env fallback belongs to the platform, and its account details are
    // not the tenant admin's to see (the success + source pair still tells
    // them everything actionable).
    return NextResponse.json({
      success: true,
      source,
      ...(source === "org" && {
        account: {
          name: account.business_profile?.name || account.settings?.dashboard?.display_name || null,
          email: account.email || null,
          id: account.id,
        },
      }),
    });
  } catch (error) {
    // Review L7: the SDK's error message can embed a (masked) key fragment —
    // log the real error, return static text.
    apiLogger.warn({ err: error }, "stripe:test-connection-failed");
    return NextResponse.json(
      { success: false, error: "Connection failed — check the key and try again" },
      { status: 400 },
    );
  }
}
