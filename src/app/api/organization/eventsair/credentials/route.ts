import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { encryptSecret } from "@/lib/eventsair-client";
import { z } from "zod";

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

    if (session.user.role !== "SUPER_ADMIN" && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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

    if (session.user.role !== "SUPER_ADMIN" && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const validated = credentialsSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "organization/eventsair/credentials:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    const org = await db.organization.findUnique({
      where: { id: session.user.organizationId },
      select: { settings: true },
    });

    const currentSettings = (org?.settings as Record<string, unknown>) || {};
    const updatedSettings = {
      ...currentSettings,
      eventsAir: {
        clientId: validated.data.clientId,
        clientSecretEncrypted: encryptSecret(validated.data.clientSecret),
        configuredAt: new Date().toISOString(),
      },
    };

    await db.organization.update({
      where: { id: session.user.organizationId },
      data: { settings: updatedSettings },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error saving EventsAir credentials" });
    return NextResponse.json({ error: "Failed to save credentials" }, { status: 500 });
  }
}
