import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { z } from "zod";

const zoomSettingsSchema = z.object({
  enabled: z.boolean(),
  defaultMeetingType: z.enum(["MEETING", "WEBINAR"]).optional(),
  autoCreateForSessions: z.boolean().optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, settings: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const settings = (event.settings as Record<string, unknown>) || {};
    const zoom = (settings.zoom as Record<string, unknown>) || {};

    return NextResponse.json({
      enabled: zoom.enabled === true,
      defaultMeetingType: zoom.defaultMeetingType || "MEETING",
      autoCreateForSessions: zoom.autoCreateForSessions === true,
    });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:settings-fetch-failed");
    return NextResponse.json({ error: "Failed to fetch Zoom settings" }, { status: 500 });
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = zoomSettingsSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "zoom:settings-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, settings: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const currentSettings = (event.settings as Record<string, unknown>) || {};
    const updatedSettings = {
      ...currentSettings,
      zoom: {
        enabled: validated.data.enabled,
        defaultMeetingType: validated.data.defaultMeetingType || "MEETING",
        autoCreateForSessions: validated.data.autoCreateForSessions || false,
      },
    };

    await db.event.update({
      where: { id: eventId },
      data: { settings: updatedSettings },
    });

    apiLogger.info({ eventId, userId: session.user.id, zoom: validated.data }, "zoom:settings-updated");
    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:settings-update-failed");
    return NextResponse.json({ error: "Failed to update Zoom settings" }, { status: 500 });
  }
}
