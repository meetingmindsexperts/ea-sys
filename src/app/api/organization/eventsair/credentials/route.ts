import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { encryptSecret } from "@/lib/eventsair-client";
import { updateOrganizationSettings } from "@/lib/event-settings";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { z } from "zod";
import { requirePermission } from "@/lib/permissions/require-permission";

const CREDENTIALS_LIMIT = 10;
const CREDENTIALS_WINDOW_MS = 3600_000;

/** A recognisable prefix and the length, never the value (the Zoom card's rule). */
function clientIdFingerprint(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return `${value.slice(0, 6)}…(${value.length})`;
}

const credentialsSchema = z.object({
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().min(1).max(500),
});

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const gate = requirePermission(session, "org.credentials", { route: "organization/eventsair/credentials:GET" });
    if (!gate.ok) return gate.response;

    const org = await db.organization.findUnique({
      where: { id: session.user.organizationId },
      select: { settings: true },
    });

    const settings = (org?.settings as Record<string, unknown>) || {};
    const eventsAir = settings.eventsAir as Record<string, unknown> | undefined;

    return NextResponse.json({
      configured: !!eventsAir?.clientId,
      clientId: eventsAir?.clientId || null,
      configuredAt: eventsAir?.configuredAt || null,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching EventsAir credentials" });
    return NextResponse.json({ error: "Failed to fetch credentials" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json()]);

    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const gate = requirePermission(session, "org.credentials", { route: "organization/eventsair/credentials:PUT" });
    if (!gate.ok) return gate.response;

    const organizationId = session.user.organizationId;
    const rl = checkRateLimit({ key: `eventsair-creds:${organizationId}`, limit: CREDENTIALS_LIMIT, windowMs: CREDENTIALS_WINDOW_MS });
    if (!rl.allowed) {
      return rateLimited(rl, {
        route: "organization/eventsair/credentials:PUT",
        userId: session.user.id,
        limit: CREDENTIALS_LIMIT,
        windowSeconds: CREDENTIALS_WINDOW_MS / 1000,
      });
    }

    const validated = credentialsSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "organization/eventsair/credentials:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    // Under the helper's row lock, so the client id it replaced is the one
    // that was really there. Only the eventsAir key is written.
    let previousClientId: unknown = null;
    await updateOrganizationSettings(organizationId, (current) => {
      previousClientId = (current.eventsAir as Record<string, unknown> | undefined)?.clientId ?? null;
      return {
        ...current,
        eventsAir: {
          clientId: validated.data.clientId,
          clientSecretEncrypted: encryptSecret(validated.data.clientSecret),
          configuredAt: new Date().toISOString(),
        },
      };
    });
    apiLogger.info({ msg: "eventsair:credentials-saved", userId: session.user.id, organizationId });

    // Who changed the credentials an import runs on, and when. Every save
    // carries a new secret (the form requires one), so it is recorded only as
    // rotated; the client id as a fingerprint. Fire-and-forget: the save has
    // already succeeded and a failed audit write must not report otherwise.
    const from = clientIdFingerprint(previousClientId);
    const to = clientIdFingerprint(validated.data.clientId);
    void db.auditLog
      .create({
        data: {
          userId: session.user.id,
          organizationId,
          action: "UPDATE_EVENTSAIR_CREDENTIALS",
          entityType: "Organization",
          entityId: organizationId,
          changes: { clientId: from === to ? { unchanged: to } : { from, to }, clientSecret: { rotated: true } },
          ipAddress: getClientIp(req),
        },
      })
      .catch((err) => apiLogger.error({ err, userId: session.user.id, msg: "eventsair:credentials-audit-failed" }));

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error saving EventsAir credentials" });
    return NextResponse.json({ error: "Failed to save credentials" }, { status: 500 });
  }
}
