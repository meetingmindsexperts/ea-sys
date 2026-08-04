import * as PrismaLib from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { isZoomConfigured, createZoomWebinar } from "@/lib/zoom";
import type { WebinarSettings } from "@/lib/webinar";
import { readWebinarSettings } from "@/lib/webinar";
import { updateEventSettings } from "@/lib/event-settings";
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

// A provisioning claim older than this is considered dead (the process crashed
// mid-provision) and may be reclaimed. A healthy provision takes seconds.
const PROVISIONING_STALE_MS = 10 * 60_000;

function defaultSessionWindow(start: Date, end: Date): { startTime: Date; endTime: Date } {
  const startTime = new Date(start);
  let endTime = new Date(end);
  if (endTime.getTime() <= startTime.getTime()) {
    endTime = new Date(startTime.getTime() + DEFAULT_WEBINAR_DURATION_MIN * 60_000);
  }
  return { startTime, endTime };
}

function asWebinarObject(cur: Record<string, unknown>): Record<string, unknown> {
  return cur.webinar && typeof cur.webinar === "object"
    ? { ...(cur.webinar as Record<string, unknown>) }
    : {};
}

export async function provisionWebinar(
  eventId: string,
  options?: { actorUserId?: string },
  /** Internal recursion guard for the lost-claim → idempotent-retry path. */
  isRetry = false,
): Promise<ProvisionResult> {
  const startedAt = Date.now();
  // True once WE hold the provisioning sentinel — governs cleanup on failure.
  let claimed = false;
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

    // Per-row tenant context (multi-tenancy sweep): org resolved from the row itself — the candidate sweep stays org-blind (worker precondition, see MULTI_TENANCY.md §13).
    return await runWithTenant(event.organizationId, async () => {
    const existingWebinar = readWebinarSettings(event.settings) ?? {};

    // Idempotency: if sessionId already set and points to a live session, no-op.
    // Still re-runs the sequence enqueue — that helper is itself idempotent, so
    // this lets users delete & re-enqueue the sequence by hitting "Re-run
    // provisioner" if they manually cleared sequence rows.
    if (existingWebinar.sessionId) {
      const existingSession = await db.eventSession.findFirst({
        where: { id: existingWebinar.sessionId, eventId: event.id },
        select: {
          id: true,
          startTime: true,
          endTime: true,
          zoomMeeting: { select: { id: true, zoomMeetingId: true } },
        },
      });
      if (existingSession) {
        if (existingSession.zoomMeeting) {
          enqueueWebinarSequenceForEvent(event.id, options?.actorUserId).catch((err) =>
            apiLogger.error(
              { err, eventId: event.id },
              "webinar:sequence-enqueue-failed",
            ),
          );
          const durationMs = Date.now() - startedAt;
          apiLogger.info(
            { eventId, sessionId: existingSession.id, durationMs },
            "webinar:provision-idempotent-noop",
          );
          return {
            ok: true,
            sessionId: existingSession.id,
            zoomMeetingId: existingSession.zoomMeeting.zoomMeetingId,
            zoomStatus: "already-attached",
            durationMs,
          };
        }
        // RE-ATTACH (Aug 4, 2026): the anchor session exists but has NO Zoom
        // webinar — the organizer deleted it (e.g. to recreate it with live
        // streaming) or the original provision failed at the Zoom step. This
        // branch used to return early with "not-configured", making "Run
        // provisioner" a silent no-op exactly when the console tells the
        // organizer to click it.
        //
        // Claims the same provisioning sentinel as a fresh provision (review
        // M7): without it, two concurrent "Run provisioner" clicks both call
        // Zoom's create API — the row-unique race resolves correctness, but
        // the loser's remote teardown is best-effort and a failed teardown
        // orphans a billable webinar.
        const reattachClaim: { outcome: "won" | "in-progress" } = { outcome: "won" };
        await updateEventSettings(event.id, (cur) => {
          const webinar = asWebinarObject(cur);
          const claimedAtMs =
            typeof webinar.provisioningAt === "string" ? Date.parse(webinar.provisioningAt) : NaN;
          if (Number.isFinite(claimedAtMs) && Date.now() - claimedAtMs < PROVISIONING_STALE_MS) {
            reattachClaim.outcome = "in-progress";
            return cur;
          }
          return { ...cur, webinar: { ...webinar, provisioningAt: new Date().toISOString() } };
        });
        if (reattachClaim.outcome === "in-progress") {
          const durationMs = Date.now() - startedAt;
          apiLogger.warn({ eventId, durationMs }, "webinar:provision-claim-contended");
          return { ok: false, reason: "provision-already-in-progress", durationMs };
        }

        let zoomStatus: ZoomProvisionStatus;
        try {
          zoomStatus = await attachZoomWebinarToAnchor(
            { id: event.id, name: event.name, timezone: event.timezone, description: event.description, organizationId: event.organizationId },
            existingSession,
            existingWebinar,
            options?.actorUserId,
          );
        } finally {
          // Release the sentinel on success AND failure — a crashed re-attach
          // must not force the next attempt to wait out the stale window.
          await updateEventSettings(event.id, (cur) => {
            const webinar = asWebinarObject(cur);
            delete webinar.provisioningAt;
            return { ...cur, webinar };
          }).catch((cleanupErr) =>
            apiLogger.error({ err: cleanupErr, eventId }, "webinar:provision-claim-cleanup-failed"),
          );
        }

        const durationMs = Date.now() - startedAt;
        const reattached = await db.zoomMeeting.findUnique({
          where: { sessionId: existingSession.id },
          select: { zoomMeetingId: true },
        });
        apiLogger.info(
          { eventId, sessionId: existingSession.id, zoomStatus, durationMs },
          "webinar:provision-reattach",
        );
        return {
          ok: true,
          sessionId: existingSession.id,
          zoomMeetingId: reattached?.zoomMeetingId ?? null,
          zoomStatus,
          durationMs,
        };
      }
    }

    // M1 (program/agenda review): claim a provisioning sentinel ATOMICALLY
    // before creating anything. provisionWebinar is fired fire-and-forget from
    // POST /api/events AND from the console's "Re-run provisioner" button —
    // without the claim, two concurrent invocations both pass the sessionId
    // check above and mint TWO anchor sessions + TWO billable Zoom webinars
    // (last settings write wins; the loser's pair is orphaned). The claim
    // rides the same SELECT…FOR UPDATE settings row lock every settings write
    // uses. A stale claim (crashed provision, >10 min) is reclaimable.
    //
    // `staleSessionId` handles the recovery flow: if settings point at a
    // session that no longer exists (operator deleted the anchor and re-runs
    // the provisioner), that dangling pointer must NOT read as "already
    // provisioned" — only a sessionId DIFFERENT from the one we just verified
    // dead means a concurrent run finished first.
    const staleSessionId = existingWebinar.sessionId ?? null;
    // Object property (not a bare let) so TS doesn't narrow it to the initial
    // literal — the assignment happens inside the locked patch closure.
    const claim: { outcome: "won" | "in-progress" | "already-provisioned" } = { outcome: "won" };
    await updateEventSettings(event.id, (cur) => {
      const webinar = asWebinarObject(cur);
      if (typeof webinar.sessionId === "string" && webinar.sessionId !== staleSessionId) {
        claim.outcome = "already-provisioned";
        return cur;
      }
      const claimedAtMs =
        typeof webinar.provisioningAt === "string" ? Date.parse(webinar.provisioningAt) : NaN;
      if (Number.isFinite(claimedAtMs) && Date.now() - claimedAtMs < PROVISIONING_STALE_MS) {
        claim.outcome = "in-progress";
        return cur;
      }
      return { ...cur, webinar: { ...webinar, provisioningAt: new Date().toISOString() } };
    });

    if (claim.outcome === "in-progress") {
      const durationMs = Date.now() - startedAt;
      apiLogger.warn({ eventId, durationMs }, "webinar:provision-claim-contended");
      return { ok: false, reason: "provision-already-in-progress", durationMs };
    }
    if (claim.outcome === "already-provisioned") {
      // A concurrent run finished between our settings read and the claim.
      // Re-enter once — the fresh settings now carry its sessionId, so the
      // idempotent branch above returns its result. The guard prevents a loop
      // if state churns pathologically between retries.
      if (isRetry) {
        const durationMs = Date.now() - startedAt;
        apiLogger.error({ eventId, durationMs }, "webinar:provision-claim-conflict-loop");
        return { ok: false, reason: "provision-conflict", durationMs };
      }
      apiLogger.info({ eventId }, "webinar:provision-lost-claim-retrying-idempotent");
      return provisionWebinar(eventId, options, true);
    }
    claimed = true;

    // Create the anchor session for the webinar
    const { startTime, endTime } = defaultSessionWindow(event.startDate, event.endDate);
    const eventSession = await db.eventSession.create({
      data: {
        eventId: event.id,
        organizationId: event.organizationId, // multi-tenancy: Sessions sweep
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
            organizationId: event.organizationId,
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
    const nextWebinar: WebinarSettings = {
      ...existingWebinar,
      autoCreated: true,
      sessionId: eventSession.id,
      autoProvisionZoom: existingWebinar.autoProvisionZoom ?? true,
      waitingRoom: existingWebinar.waitingRoom ?? false,
      autoRecording: existingWebinar.autoRecording ?? "cloud",
      automationEnabled: existingWebinar.automationEnabled ?? true,
    };
    // JSON round-trip strips undefined (Prisma's Json type rejects it)
    // before the atomic merge. Function-form: merge over the LOCKED current
    // webinar object (not the pre-claim snapshot) so a lobby-settings save
    // that landed while we provisioned isn't clobbered, and drop the
    // provisioning sentinel in the same write.
    const cleanWebinar = JSON.parse(JSON.stringify(nextWebinar)) as Record<string, unknown>;
    await updateEventSettings(event.id, (cur) => {
      const merged = { ...asWebinarObject(cur), ...cleanWebinar };
      delete merged.provisioningAt;
      return { ...cur, webinar: merged };
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
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    apiLogger.error({ err, eventId, durationMs }, "webinar:provision-failed");
    // Best-effort: release OUR claim so the next attempt doesn't have to wait
    // out the stale window. Only when we actually hold it — never clear a
    // concurrent run's live claim.
    if (claimed) {
      try {
        await updateEventSettings(eventId, (cur) => {
          const webinar = asWebinarObject(cur);
          delete webinar.provisioningAt;
          return { ...cur, webinar };
        });
      } catch (cleanupErr) {
        apiLogger.error({ err: cleanupErr, eventId }, "webinar:provision-claim-cleanup-failed");
      }
    }
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "unknown-error",
      durationMs,
    };
  }
}

/**
 * Create a fresh Zoom webinar for an EXISTING anchor session that lost (or
 * never got) one — the "Run provisioner" recovery path. Uses the SESSION's own
 * times (the anchor may have been retimed since the event was created). Never
 * throws; a concurrent create losing the `sessionId @unique` race tears down
 * its just-created remote webinar (the H2 pattern) and reports
 * "already-attached".
 */
async function attachZoomWebinarToAnchor(
  event: {
    id: string;
    name: string;
    timezone: string | null;
    description: string | null;
    organizationId: string;
  },
  anchor: { id: string; startTime: Date; endTime: Date },
  webinarSettings: WebinarSettings,
  actorUserId?: string,
): Promise<ZoomProvisionStatus> {
  const zoomReady = await isZoomConfigured(event.organizationId);
  if (!zoomReady) {
    apiLogger.info({ eventId: event.id }, "webinar:reattach-zoom-not-configured");
    return "not-configured";
  }

  const duration = Math.max(
    1,
    Math.ceil((anchor.endTime.getTime() - anchor.startTime.getTime()) / 60_000),
  );

  let zoomResponse: Awaited<ReturnType<typeof createZoomWebinar>>;
  try {
    zoomResponse = await createZoomWebinar(event.organizationId, {
      topic: event.name,
      startTime: anchor.startTime.toISOString(),
      duration,
      timezone: event.timezone ?? undefined,
      agenda: event.description ?? undefined,
      autoRecording: webinarSettings.autoRecording ?? "cloud",
    });
  } catch (err) {
    apiLogger.error({ err, eventId: event.id, sessionId: anchor.id }, "webinar:reattach-zoom-create-failed");
    return "failed";
  }

  try {
    await db.zoomMeeting.create({
      data: {
        sessionId: anchor.id,
        eventId: event.id,
        organizationId: event.organizationId,
        zoomMeetingId: String(zoomResponse.id),
        meetingType: "WEBINAR",
        joinUrl: zoomResponse.join_url,
        startUrl: zoomResponse.start_url,
        passcode: zoomResponse.password,
        duration,
        zoomResponse: JSON.parse(JSON.stringify(zoomResponse)),
      },
    });
  } catch (err) {
    // Either we lost the sessionId-unique race to a concurrent attach, or the
    // row insert failed transiently (pool timeout, connection closed). In BOTH
    // cases the just-minted remote webinar has no local row → tear it down so
    // it isn't an orphaned billable room. But only a genuine P2002 means "a
    // sibling won" (review M6) — a transient failure must report "failed", not
    // masquerade as already-attached.
    const { deleteRemoteZoomMeeting } = await import("@/lib/zoom/cleanup");
    const tornDown = await deleteRemoteZoomMeeting({
      organizationId: event.organizationId,
      meetingType: "WEBINAR",
      zoomMeetingId: String(zoomResponse.id),
      reason: "provision-reattach-conflict-rollback",
    });
    const isUniqueRace =
      err instanceof PrismaLib.Prisma.PrismaClientKnownRequestError && err.code === "P2002";
    if (isUniqueRace) {
      apiLogger.warn({ err, eventId: event.id, sessionId: anchor.id }, "webinar:reattach-lost-race");
      return "already-attached";
    }
    apiLogger.error(
      { err, eventId: event.id, sessionId: anchor.id, remoteTornDown: tornDown },
      "webinar:reattach-row-create-failed",
    );
    return "failed";
  }

  apiLogger.info(
    { eventId: event.id, sessionId: anchor.id, zoomMeetingId: String(zoomResponse.id) },
    "webinar:zoom-webinar-reattached",
  );

  // The sequence emails need a joinUrl to render — now that one exists,
  // (re-)enqueue. Idempotent inside; fire-and-forget.
  enqueueWebinarSequenceForEvent(event.id, actorUserId).catch((err) =>
    apiLogger.error({ err, eventId: event.id }, "webinar:sequence-enqueue-failed"),
  );

  return "created";
}
