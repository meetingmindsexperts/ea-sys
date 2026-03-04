import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { decryptSecret, fetchEventDetails } from "@/lib/eventsair-client";

const importSchema = z.object({
  eventsAirEventId: z.string().min(1),
});

/** POST: Create a new EA-SYS event from an EventsAir event */
export async function POST(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json()]);

    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = importSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    // Check if already imported
    const existing = await db.event.findFirst({
      where: {
        organizationId: session.user.organizationId,
        externalSource: "eventsair",
        externalId: validated.data.eventsAirEventId,
      },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json({
        eventId: existing.id,
        alreadyImported: true,
        message: "This event has already been imported",
      });
    }

    // Get org credentials
    const org = await db.organization.findUnique({
      where: { id: session.user.organizationId },
      select: { settings: true },
    });
    const settings = (org?.settings as Record<string, unknown>) || {};
    const eventsAirCfg = settings.eventsAir as Record<string, unknown> | undefined;

    if (!eventsAirCfg?.clientId || !eventsAirCfg?.clientSecretEncrypted) {
      return NextResponse.json({ error: "EventsAir not configured" }, { status: 400 });
    }

    const creds = {
      clientId: eventsAirCfg.clientId as string,
      clientSecret: decryptSecret(eventsAirCfg.clientSecretEncrypted as string),
    };

    // Fetch event details from EventsAir
    const eaEvent = await fetchEventDetails(creds, validated.data.eventsAirEventId);

    // Generate a unique slug
    const baseSlug = (eaEvent.alias || eaEvent.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);

    let slug = baseSlug;
    let suffix = 1;
    while (
      await db.event.findFirst({
        where: { organizationId: session.user.organizationId, slug },
        select: { id: true },
      })
    ) {
      slug = `${baseSlug}-${suffix++}`;
    }

    // Create the event
    const event = await db.event.create({
      data: {
        organizationId: session.user.organizationId,
        name: eaEvent.name,
        slug,
        startDate: new Date(eaEvent.startDate),
        endDate: new Date(eaEvent.endDate),
        timezone: eaEvent.timezone || "UTC",
        venue: eaEvent.venue?.name || null,
        city: eaEvent.venue?.city || null,
        country: eaEvent.venue?.country || null,
        status: "DRAFT",
        externalSource: "eventsair",
        externalId: eaEvent.id,
      },
    });

    return NextResponse.json({ eventId: event.id, alreadyImported: false }, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing EventsAir event" });
    return NextResponse.json({ error: "Failed to import event" }, { status: 500 });
  }
}
