import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { isZoomConfigured, createZoomWebinar } from "@/lib/zoom";
import type { WebinarSettings } from "@/lib/webinar";
import { readWebinarSettings } from "@/lib/webinar";
import { enqueueWebinarSequenceForEvent } from "@/lib/webinar-email-sequence";

export type ZoomProvisionStatus =
  | "created"
  | "already-attached"
  | "not-configured"
  | "failed";

export type ProvisionResult =
  | {
      ok: true;
      sessionId: string;
      zoomMeetingId: string | null;
      zoomStatus: ZoomProvisionStatus;
      durationMs: number;
      reason?: undefined;
    }
  | { ok: false; reason: string; durationMs: number };

const DEFAULT_WEBINAR_DURATION_MIN = 60;

function defaultSessionWindow(start: Date, end: Date): { startTime: Date; endTime: Date } {
  const startTime = new Date(start);
  let endTime = new Date(end);
  if (endTime.getTime() <= startTime.getTime()) {
    endTime = new Date(startTime.getTime() + DEFAULT_WEBINAR_DURATION_MIN * 60_000);
  }
  return { startTime, endTime };
}

export async function provisionWebinar(
  eventId: string,
  options?: { actorUserId?: string },
): Promise<ProvisionResult> {
  const startedAt = Date.now();
  try {
    const event = await db.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        timezone: true,
        description: true,
        slug: true,
        organizationId: true,
        settings: true,
      },
    });

    if (!event) {
      return { ok: false, reason: "event-not-found", durationMs: Date.now() - startedAt };
    }

    const existingWebinar = readWebinarSettings(event.settings) ?? {};

    // Idempotency: if sessionId already set and points to a live session, no-op.
    // Still re-runs the sequence enqueue — that helper is itself idempotent, so
    // this lets users delete & re-enqueue the sequence by hitting "Re-run
    // provisioner" if they manually cleared sequence rows.
    if (existingWebinar.sessionId) {
      const existingSession = await db.eventSession.findFirst({
        where: { id: existingWebinar.sessionId, eventId: event.id },
        select: { id: true, zoomMeeting: { select: { id: true, zoomMeetingId: true } } },
      });
      if (existingSession) {
        if (existingSession.zoomMeeting) {
          enqueueWebinarSequenceForEvent(event.id, options?.actorUserId).catch((err) =>
            apiLogger.error(
              { err, eventId: event.id },
              "webinar:sequence-enqueue-failed",
            ),
          );
        }
        const durationMs = Date.now() - startedAt;
        apiLogger.info(
          { eventId, sessionId: existingSession.id, durationMs },
          "webinar:provision-idempotent-noop",
        );
        return {
          ok: true,
          sessionId: existingSession.id,
          zoomMeetingId: existingSession.zoomMeeting?.zoomMeetingId ?? null,
          zoomStatus: existingSession.zoomMeeting ? "already-attached" : "not-configured",
          durationMs,
        };
      }
    }

    // Create the anchor session for the webinar
    const { startTime, endTime } = defaultSessionWindow(event.startDate, event.endDate);
    const eventSession = await db.eventSession.create({
      data: {
        eventId: event.id,
        name: event.name,
        description: event.description ?? null,
        startTime,
        endTime,
      },
      select: { id: true },
    });

    apiLogger.info(
      { eventId: event.id, sessionId: eventSession.id },
      "webinar:anchor-session-created",
    );

    // Create the Zoom webinar if the org has Zoom configured
    let zoomMeetingIdForReturn: string | null = null;
    let zoomStatus: ZoomProvisionStatus = "not-configured";
    const zoomReady = await isZoomConfigured(event.organizationId);
    if (zoomReady) {
      const zoomStartedAt = Date.now();
      try {
        const duration = Math.max(
          1,
          Math.ceil((endTime.getTime() - startTime.getTime()) / 60_000),
        );
        const zoomResponse = await createZoomWebinar(event.organizationId, {
          topic: event.name,
          startTime: startTime.toISOString(),
          duration,
          timezone: event.timezone,
          agenda: event.description ?? undefined,
          autoRecording: existingWebinar.autoRecording ?? "cloud",
        });

        const zoomMeeting = await db.zoomMeeting.create({
          data: {
            sessionId: eventSession.id,
            eventId: event.id,
            zoomMeetingId: String(zoomResponse.id),
            meetingType: "WEBINAR",
            joinUrl: zoomResponse.join_url,
            startUrl: zoomResponse.start_url,
            passcode: zoomResponse.password,
            duration,
            zoomResponse: JSON.parse(JSON.stringify(zoomResponse)),
          },
          select: { zoomMeetingId: true },
        });
        zoomMeetingIdForReturn = zoomMeeting.zoomMeetingId;
        zoomStatus = "created";

        apiLogger.info(
          {
            eventId: event.id,
            sessionId: eventSession.id,
            zoomMeetingId: zoomMeeting.zoomMeetingId,
            zoomDurationMs: Date.now() - zoomStartedAt,
          },
          "webinar:zoom-webinar-provisioned",
        );
      } catch (err) {
        zoomStatus = "failed";
        apiLogger.error(
          {
            err,
            eventId: event.id,
            sessionId: eventSession.id,
            zoomDurationMs: Date.now() - zoomStartedAt,
          },
          "webinar:zoom-provision-failed",
        );
        // Fall through — session exists, Zoom can be attached later from the console
      }
    } else {
      apiLogger.info(
        { eventId: event.id },
        "webinar:zoom-not-configured-skipping-auto-provision",
      );
    }

    // Persist webinar settings JSON on the event
    const settingsObj = (event.settings as Record<string, unknown>) || {};
    const nextWebinar: WebinarSettings = {
      ...existingWebinar,
      autoCreated: true,
      sessionId: eventSession.id,
      autoProvisionZoom: existingWebinar.autoProvisionZoom ?? true,
      waitingRoom: existingWebinar.waitingRoom ?? false,
      autoRecording: existingWebinar.autoRecording ?? "cloud",
      automationEnabled: existingWebinar.automationEnabled ?? true,
    };
    const mergedSettings = JSON.parse(
      JSON.stringify({ ...settingsObj, webinar: nextWebinar }),
    );
    await db.event.update({
      where: { id: event.id },
      data: { settings: mergedSettings },
    });

    // Enqueue the 4 future email phases (reminder-24h, reminder-1h, live-now,
    // thank-you). Only runs if the Zoom webinar was freshly created here —
    // without a joinUrl the emails can't render. Idempotent inside, safe on
    // retry. Fire-and-forget so a sequence failure never fails provisioning.
    // (The "already-attached" case returns early higher up via the idempotency
    // branch and never reaches this point.)
    if (zoomStatus === "created") {
      enqueueWebinarSequenceForEvent(event.id, options?.actorUserId).catch((err) =>
        apiLogger.error(
          { err, eventId: event.id },
          "webinar:sequence-enqueue-failed",
        ),
      );
    }

    const durationMs = Date.now() - startedAt;
    apiLogger.info(
      {
        eventId: event.id,
        sessionId: eventSession.id,
        zoomStatus,
        zoomMeetingId: zoomMeetingIdForReturn,
        durationMs,
      },
      "webinar:provisioned",
    );

    return {
      ok: true,
      sessionId: eventSession.id,
      zoomMeetingId: zoomMeetingIdForReturn,
      zoomStatus,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    apiLogger.error({ err, eventId, durationMs }, "webinar:provision-failed");
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "unknown-error",
      durationMs,
    };
  }
}
