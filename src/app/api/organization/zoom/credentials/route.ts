import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { apiLogger } from "@/lib/logger";
import { encryptSecret } from "@/lib/eventsair-client";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { updateOrganizationSettings } from "@/lib/event-settings";
import { z } from "zod";

const credentialsSchema = z.object({
  accountId: z.string().min(1).max(500),
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().max(500).optional(), // optional on update — keeps existing if empty
  // Meeting SDK credentials (dev + prod)
  sdkKeyDev: z.string().max(500).optional(),
  sdkSecretDev: z.string().max(500).optional(),
  sdkKeyProd: z.string().max(500).optional(),
  sdkSecretProd: z.string().max(500).optional(),
  sdkMode: z.enum(["dev", "prod"]).optional(),
});

/**
 * A credential's first few characters, or a marker for absent/secret.
 *
 * Keys (Account ID, Client ID, SDK Key) are not secrets — the SDK key is handed
 * to every browser that joins — but an audit table is read by more people than
 * a settings page, so only a prefix is kept. Secrets are never recorded at all,
 * just whether they changed.
 */
function credentialFingerprint(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return `${value.slice(0, 6)}…(${value.length})`;
}

/**
 * Which fields a save actually altered, as a before → after of fingerprints.
 *
 * Written because on 2026-08-19 two people changed these credentials on
 * production hours apart, and the only trace was a single `configuredAt` that
 * each save overwrote. Reconstructing "what was the SDK key before 11:50, and
 * who changed it" was impossible, which mattered because that value was the
 * cause of a failed live webinar. A prefix diff answers that question without
 * putting a credential in the audit table.
 */
function describeCredentialChange(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Prisma.JsonObject {
  const keyFields = ["accountId", "clientId", "sdkKeyDev", "sdkKeyProd"];
  const secretFields = [
    "clientSecretEncrypted",
    "sdkSecretDevEncrypted",
    "sdkSecretProdEncrypted",
  ];

  const changed: Prisma.JsonObject = {};
  for (const f of keyFields) {
    const from = credentialFingerprint(before[f]);
    const to = credentialFingerprint(after[f]);
    if (from !== to) changed[f] = { from, to };
  }
  for (const f of secretFields) {
    // Never the value, not even a prefix: this is ciphertext of a live secret.
    if (before[f] !== after[f]) changed[f] = { rotated: true };
  }
  if (before.sdkMode !== after.sdkMode) {
    changed.sdkMode = { from: before.sdkMode ?? null, to: after.sdkMode ?? null };
  }
  return changed;
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (session.user.role !== "SUPER_ADMIN" && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const org = await db.organization.findUnique({
      where: { id: session.user.organizationId },
      select: { settings: true },
    });

    const settings = (org?.settings as Record<string, unknown>) || {};
    const zoom = settings.zoom as Record<string, unknown> | undefined;

    return NextResponse.json({
      configured: !!zoom?.clientId,
      hasClientSecret: !!zoom?.clientSecretEncrypted,
      accountId: zoom?.accountId || null,
      clientId: zoom?.clientId || null,
      configuredAt: zoom?.configuredAt || null,
      // SDK Dev
      sdkKeyDev: zoom?.sdkKeyDev || null,
      hasSdkSecretDev: !!zoom?.sdkSecretDevEncrypted,
      // SDK Prod
      sdkKeyProd: zoom?.sdkKeyProd || null,
      hasSdkSecretProd: !!zoom?.sdkSecretProdEncrypted,
      // Active mode
      sdkMode: zoom?.sdkMode || "dev",
    });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:credentials-fetch-failed");
    return NextResponse.json({ error: "Failed to fetch credentials" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json()]);

    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (session.user.role !== "SUPER_ADMIN" && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `zoom-creds:${session.user.organizationId}`,
      limit: 10,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: session.user.id }, "zoom:credentials-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = credentialsSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "zoom:credentials-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    const org = await db.organization.findUnique({
      where: { id: session.user.organizationId },
      select: { settings: true },
    });

    const currentSettings = (org?.settings as Record<string, unknown>) || {};
    const existingZoom = typeof currentSettings.zoom === "object" && currentSettings.zoom !== null
      ? (currentSettings.zoom as Record<string, unknown>)
      : {};

    // A Server-to-Server OAuth app has NO Meeting SDK credentials. Pasting its
    // Client ID into an SDK key field is accepted silently by everything up to
    // and including Zoom's own signature endpoint: we mint a signature, the
    // join route answers 200, and the failure only appears as errorCode 3712
    // ("Signature is invalid") in the ATTENDEE's browser, minutes later, during
    // a live webinar. That is what happened on 2026-08-19 and it cost an
    // afternoon, because nothing on the server had any reason to complain.
    //
    // The two credential sets look interchangeable in the Zoom console and are
    // stored side by side here, so this confusion is the default outcome rather
    // than an unlucky one. Refuse it at the only moment we can still say so
    // cheaply, and name the fix rather than just the error.
    const effectiveClientId = validated.data.clientId.trim();
    const sdkKeyFields: Array<[string, string | undefined]> = [
      ["sdkKeyProd", validated.data.sdkKeyProd],
      ["sdkKeyDev", validated.data.sdkKeyDev],
    ];
    for (const [field, value] of sdkKeyFields) {
      if (value && value.trim() === effectiveClientId) {
        apiLogger.warn(
          { userId: session.user.id, organizationId: session.user.organizationId, field },
          "zoom:credentials-sdk-key-is-oauth-client-id",
        );
        return NextResponse.json(
          {
            error:
              "That is your Server-to-Server OAuth Client ID, which cannot sign Meeting SDK joins. " +
              "SDK credentials come from a separate General App with the Meeting SDK feature enabled: " +
              "use that app's Client ID and Client Secret here.",
            code: "SDK_KEY_IS_OAUTH_CLIENT_ID",
            field,
          },
          { status: 400 },
        );
      }
    }

    const zoomData: Record<string, unknown> = {
      ...existingZoom,
      accountId: validated.data.accountId,
      clientId: validated.data.clientId,
      configuredAt: new Date().toISOString(),
    };

    // Only update client secret if provided (keeps existing encrypted value otherwise)
    if (validated.data.clientSecret) {
      zoomData.clientSecretEncrypted = encryptSecret(validated.data.clientSecret);
    }

    // SDK Dev credentials
    if (validated.data.sdkKeyDev) {
      zoomData.sdkKeyDev = validated.data.sdkKeyDev;
    }
    if (validated.data.sdkSecretDev) {
      zoomData.sdkSecretDevEncrypted = encryptSecret(validated.data.sdkSecretDev);
    }

    // SDK Prod credentials
    if (validated.data.sdkKeyProd) {
      zoomData.sdkKeyProd = validated.data.sdkKeyProd;
    }
    if (validated.data.sdkSecretProd) {
      zoomData.sdkSecretProdEncrypted = encryptSecret(validated.data.sdkSecretProd);
    }

    // SDK mode (dev or prod)
    if (validated.data.sdkMode) {
      zoomData.sdkMode = validated.data.sdkMode;
    }

    // Atomic merge — only the zoom key is written; other settings keys are
    // preserved by the helper. JSON round-trip strips undefined.
    const cleanZoom = JSON.parse(JSON.stringify(zoomData));
    await updateOrganizationSettings(session.user.organizationId, { zoom: cleanZoom });

    const changed = describeCredentialChange(existingZoom, cleanZoom);
    apiLogger.info(
      { userId: session.user.id, changed, sdkMode: cleanZoom.sdkMode },
      "zoom:credentials-saved",
    );

    // Fire-and-forget: the credentials are already written, and losing the
    // audit row must not turn a successful save into a 500.
    void db.auditLog
      .create({
        data: {
          userId: session.user.id,
          organizationId: session.user.organizationId,
          action: "UPDATE_ZOOM_CREDENTIALS",
          entityType: "Organization",
          entityId: session.user.organizationId,
          changes: { changed, sdkMode: cleanZoom.sdkMode ?? null, ip: getClientIp(req) },
          ipAddress: getClientIp(req),
        },
      })
      .catch((err) =>
        apiLogger.error({ err, userId: session.user.id }, "zoom:credentials-audit-failed"),
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:credentials-save-failed");
    return NextResponse.json({ error: "Failed to save credentials" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = await auth();
    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (session.user.role !== "SUPER_ADMIN" && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Atomic delete of just the zoom key — other settings keys preserved.
    await updateOrganizationSettings(session.user.organizationId, (cur) => {
      const next = { ...cur };
      delete next.zoom;
      return next;
    });

    apiLogger.info({ userId: session.user.id }, "zoom:credentials-deleted");

    // Removing the whole Zoom integration is the single most consequential
    // change on this route: every webinar stops being creatable and every SDK
    // join degrades to opening Zoom directly. It gets a row.
    void db.auditLog
      .create({
        data: {
          userId: session.user.id,
          organizationId: session.user.organizationId,
          action: "DELETE_ZOOM_CREDENTIALS",
          entityType: "Organization",
          entityId: session.user.organizationId,
          changes: { cleared: true },
        },
      })
      .catch((err) =>
        apiLogger.error({ err, userId: session.user.id }, "zoom:credentials-audit-failed"),
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:credentials-delete-failed");
    return NextResponse.json({ error: "Failed to delete credentials" }, { status: 500 });
  }
}
