import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { encryptSecret } from "@/lib/eventsair-client";
import { checkRateLimit } from "@/lib/security";
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

    apiLogger.info({ userId: session.user.id }, "zoom:credentials-saved");
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
    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:credentials-delete-failed");
    return NextResponse.json({ error: "Failed to delete credentials" }, { status: 500 });
  }
}
