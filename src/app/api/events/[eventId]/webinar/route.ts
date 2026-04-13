import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { readWebinarSettings, type WebinarSettings } from "@/lib/webinar";
import { provisionWebinar } from "@/lib/webinar-provisioner";

type RouteParams = { params: Promise<{ eventId: string }> };

const updateWebinarSchema = z.object({
  autoProvisionZoom: z.boolean().optional(),
  defaultPasscode: z.string().max(10).optional(),
  waitingRoom: z.boolean().optional(),
  autoRecording: z.enum(["none", "local", "cloud"]).optional(),
  automationEnabled: z.boolean().optional(),
});

// ── GET — Return webinar settings + anchor session + zoom meeting ───

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, name: true, eventType: true, slug: true, settings: true, organizationId: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const webinar = readWebinarSettings(event.settings) ?? {};

    // Parallelize anchor session + zoom meeting lookup
    const [anchorSession, zoomMeeting] = await Promise.all([
      webinar.sessionId
        ? db.eventSession.findFirst({
            where: { id: webinar.sessionId, eventId },
            select: {
              id: true,
              name: true,
              startTime: true,
              endTime: true,
              description: true,
            },
          })
        : Promise.resolve(null),
      webinar.sessionId
        ? db.zoomMeeting.findUnique({
            where: { sessionId: webinar.sessionId },
            select: {
              id: true,
              zoomMeetingId: true,
              meetingType: true,
              joinUrl: true,
              startUrl: true,
              passcode: true,
              duration: true,
              recordingUrl: true,
              recordingPassword: true,
              recordingDuration: true,
              recordingFetchedAt: true,
              recordingStatus: true,
            },
          })
        : Promise.resolve(null),
    ]);

    return NextResponse.json({
      event: {
        id: event.id,
        name: event.name,
        slug: event.slug,
        eventType: event.eventType,
      },
      webinar,
      anchorSession,
      zoomMeeting,
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar:settings-fetch-failed");
    return NextResponse.json({ error: "Failed to fetch webinar settings" }, { status: 500 });
  }
}

// ── PUT — Update webinar settings JSON ─────────────────────────────

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-settings:${eventId}`,
      limit: 20,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "webinar:settings-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = updateWebinarSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ errors: validated.error.flatten() }, "webinar:settings-validation-failed");
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, settings: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const settingsObj = (event.settings as Record<string, unknown>) || {};
    const existingWebinar = readWebinarSettings(event.settings) ?? {};
    const nextWebinar: WebinarSettings = { ...existingWebinar, ...validated.data };

    const mergedSettings = JSON.parse(
      JSON.stringify({ ...settingsObj, webinar: nextWebinar }),
    );

    await db.event.update({
      where: { id: eventId },
      data: { settings: mergedSettings },
    });

    apiLogger.info(
      { eventId, userId: session.user.id, webinar: nextWebinar },
      "webinar:settings-updated",
    );

    return NextResponse.json({ webinar: nextWebinar });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar:settings-update-failed");
    return NextResponse.json({ error: "Failed to update webinar settings" }, { status: 500 });
  }
}

// ── POST — Manually re-run the provisioner (idempotent) ────────────

export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-provision:${eventId}`,
      limit: 10,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "webinar:provision-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const result = await provisionWebinar(eventId, { actorUserId: session.user.id });
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 500 });
    }
    return NextResponse.json(result);
  } catch (error) {
    apiLogger.error({ err: error }, "webinar:manual-provision-failed");
    return NextResponse.json({ error: "Failed to provision webinar" }, { status: 500 });
  }
}
