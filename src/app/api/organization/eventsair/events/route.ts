import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { decryptSecret, listEvents } from "@/lib/eventsair-client";

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

    if (!eventsAir?.clientId || !eventsAir?.clientSecretEncrypted) {
      return NextResponse.json({ error: "EventsAir not configured" }, { status: 400 });
    }

    const clientSecret = decryptSecret(eventsAir.clientSecretEncrypted as string);
    const events = await listEvents({
      clientId: eventsAir.clientId as string,
      clientSecret,
    });

    // Sandbox/archived events are already filtered at the API level
    const filtered = events;

    // Check which events are already imported
    const importedEvents = await db.event.findMany({
      where: {
        organizationId: session.user.organizationId,
        externalSource: "eventsair",
        externalId: { not: null },
      },
      select: { externalId: true, id: true },
    });
    const importedMap = new Map(importedEvents.map((e) => [e.externalId, e.id]));

    const annotated = filtered.map((e) => ({
      ...e,
      alreadyImported: importedMap.has(e.id),
      eaSysEventId: importedMap.get(e.id) || null,
    }));

    return NextResponse.json(annotated);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error listing EventsAir events" });
    return NextResponse.json({ error: "Failed to list EventsAir events" }, { status: 500 });
  }
}
