import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { encryptSecret } from "@/lib/eventsair-client";
import { checkRateLimit } from "@/lib/security";
import { z } from "zod";

const credentialsSchema = z.object({
  accountId: z.string().min(1).max(500),
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().min(1).max(500),
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
      accountId: zoom?.accountId || null,
      clientId: zoom?.clientId || null,
      configuredAt: zoom?.configuredAt || null,
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
    const updatedSettings = {
      ...currentSettings,
      zoom: {
        ...(typeof currentSettings.zoom === "object" && currentSettings.zoom !== null ? currentSettings.zoom : {}),
        accountId: validated.data.accountId,
        clientId: validated.data.clientId,
        clientSecretEncrypted: encryptSecret(validated.data.clientSecret),
        configuredAt: new Date().toISOString(),
      },
    };

    await db.organization.update({
      where: { id: session.user.organizationId },
      data: { settings: updatedSettings },
    });

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

    const org = await db.organization.findUnique({
      where: { id: session.user.organizationId },
      select: { settings: true },
    });

    const currentSettings = (org?.settings as Record<string, unknown>) || {};
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { zoom: _removed, ...rest } = currentSettings;

    await db.organization.update({
      where: { id: session.user.organizationId },
      data: { settings: rest as Parameters<typeof db.organization.update>[0]["data"]["settings"] },
    });

    apiLogger.info({ userId: session.user.id }, "zoom:credentials-deleted");
    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:credentials-delete-failed");
    return NextResponse.json({ error: "Failed to delete credentials" }, { status: 500 });
  }
}
