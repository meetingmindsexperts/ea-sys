import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { decryptSecret, testConnection } from "@/lib/eventsair-client";

export async function POST() {
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
