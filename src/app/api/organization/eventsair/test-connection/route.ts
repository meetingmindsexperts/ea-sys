import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { decryptSecret, testConnection } from "@/lib/eventsair-client";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";

// Each test is a live call to EventsAir with the stored secret.
const TEST_LIMIT = 30;
const TEST_WINDOW_MS = 3600_000;

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const gate = requirePermission(session, "org.credentials", { route: "organization/eventsair/test-connection:POST" });
    if (!gate.ok) return gate.response;

    const rl = checkRateLimit({ key: `eventsair-test:${session.user.organizationId}`, limit: TEST_LIMIT, windowMs: TEST_WINDOW_MS });
    if (!rl.allowed) {
      return rateLimited(rl, {
        route: "organization/eventsair/test-connection:POST",
        userId: session.user.id,
        limit: TEST_LIMIT,
        windowSeconds: TEST_WINDOW_MS / 1000,
      });
    }

    const org = await db.organization.findUnique({
      where: { id: session.user.organizationId },
      select: { settings: true },
    });

    const settings = (org?.settings as Record<string, unknown>) || {};
    const eventsAir = settings.eventsAir as Record<string, unknown> | undefined;

    if (!eventsAir?.clientId || !eventsAir?.clientSecretEncrypted) {
      return NextResponse.json({ connected: false, error: "Credentials not configured" });
    }

    const clientSecret = decryptSecret(eventsAir.clientSecretEncrypted as string);
    const connected = await testConnection({
      clientId: eventsAir.clientId as string,
      clientSecret,
    });

    return NextResponse.json({ connected });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error testing EventsAir connection" });
    return NextResponse.json({ connected: false, error: "Connection test failed" });
  }
}
