import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { updateEventSettings } from "@/lib/event-settings";
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
    // Org-independent roles (REVIEWER/SUBMITTER/REGISTRANT) have a null org.
    // Guard before the query: `organizationId: null` is a Prisma validation
    // error (Event.organizationId is non-nullable) — the `organizationId!`
    // footgun that fired zoom:settings-fetch-failed.
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      apiLogger.warn(
        { userId: session.user.id, role: session.user.role, eventId },
        "zoom:settings-no-org",
      );
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Fetch the event's per-event Zoom settings AND whether the ORG has Zoom
    // credentials configured. The org-credentials endpoint is ADMIN-only, but
    // an ORGANIZER legitimately manages per-event Zoom and needs to know
    // whether the org is wired up — so we surface a non-secret boolean here
    // (no keys/identifiers), letting the event-level card render for organizers
    // without depending on the admin-only credentials route.
    const [event, org] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId },
        select: { id: true, settings: true },
      }),
      db.organization.findUnique({
        where: { id: organizationId },
        select: { settings: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const settings = (event.settings as Record<string, unknown>) || {};
    const zoom = (settings.zoom as Record<string, unknown>) || {};
    const orgZoom = ((org?.settings as Record<string, unknown>)?.zoom as Record<string, unknown>) || {};

    return NextResponse.json({
      enabled: zoom.enabled === true,
      defaultMeetingType: zoom.defaultMeetingType || "MEETING",
      autoCreateForSessions: zoom.autoCreateForSessions === true,
      // True when the org has Server-to-Server OAuth configured (same check the
      // admin credentials route uses for `configured`). Non-secret.
      orgConfigured: !!orgZoom.clientId,
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

    const organizationId = session.user.organizationId;
    if (!organizationId) {
      apiLogger.warn(
        { userId: session.user.id, role: session.user.role, eventId },
        "zoom:settings-update-no-org",
      );
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const validated = zoomSettingsSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "zoom:settings-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId },
      select: { id: true, settings: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    await updateEventSettings(eventId, {
      zoom: {
        enabled: validated.data.enabled,
        defaultMeetingType: validated.data.defaultMeetingType || "MEETING",
        autoCreateForSessions: validated.data.autoCreateForSessions || false,
      },
    });

    apiLogger.info({ eventId, userId: session.user.id, zoom: validated.data }, "zoom:settings-updated");
    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error }, "zoom:settings-update-failed");
    return NextResponse.json({ error: "Failed to update Zoom settings" }, { status: 500 });
  }
}
