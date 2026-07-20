import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { parseCSV, getField } from "@/lib/csv-parser";
import { notifyEventAdmins } from "@/lib/notifications";
import { createSession, type SessionStatus } from "@/services/session-service";

const SESSION_STATUS_VALUES = new Set(["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"]);

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

/**
 * Agenda CSV import. Each row delegates to `session-service.createSession()`
 * — the ONE create implementation shared with the dashboard REST POST and
 * MCP `create_session` — so imported sessions get the same event-timezone
 * date validation (OUTSIDE_EVENT_DATES), capacity rules, audit rows and
 * stats refresh as every other create path (this route used to be a raw
 * `db.eventSession.create` that predated the July 16 service extraction).
 * Per-row notifications are suppressed; ONE summary notification is sent
 * for the batch instead.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const rateLimit = checkRateLimit({
      key: `import-sessions:org:${session.user.organizationId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      apiLogger.warn({ msg: "events/import-sessions:rate-limited", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return NextResponse.json(
        { error: "Import limit reached. Maximum 10 imports per hour." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      apiLogger.warn({ msg: "events/import-sessions:no-file", eventId, userId: session.user.id });
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const text = await file.text();
    const { headers, rows, error: parseError } = parseCSV(text);
    if (parseError) {
      apiLogger.warn({ msg: "events/import-sessions:parse-error", eventId, userId: session.user.id, parseError });
      return NextResponse.json({ error: parseError }, { status: 400 });
    }

    const idx = {
      name: headers.indexOf("name"),
      startTime: headers.indexOf("starttime"),
      endTime: headers.indexOf("endtime"),
      description: headers.indexOf("description"),
      location: headers.indexOf("location"),
      capacity: headers.indexOf("capacity"),
      track: headers.indexOf("track"),
      speakerEmails: headers.indexOf("speakeremails"),
      status: headers.indexOf("status"),
    };

    if (idx.name === -1 || idx.startTime === -1 || idx.endTime === -1) {
      apiLogger.warn({ msg: "events/import-sessions:missing-columns", eventId, userId: session.user.id, headers });
      return NextResponse.json(
        { error: "CSV must have name, startTime, and endTime columns" },
        { status: 400 }
      );
    }

    // Access-scoped, not just org-scoped — buildEventAccessWhere keeps this
    // consistent with the sessions/tracks routes (an org-null SUPER_ADMIN
    // used to 404 on the hand-rolled organizationId check).
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "events/import-sessions:event-access-denied", eventId, userId: session.user.id, role: session.user.role });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Load existing tracks and speakers for this event
    const [existingTracks, existingSpeakers] = await Promise.all([
      db.track.findMany({ where: { eventId }, select: { id: true, name: true } }),
      db.speaker.findMany({ where: { eventId }, select: { id: true, email: true } }),
    ]);

    const trackByName = new Map(existingTracks.map((t) => [t.name.toLowerCase(), t.id]));
    const speakerByEmail = new Map(existingSpeakers.map((s) => [s.email.toLowerCase(), s.id]));

    apiLogger.info({ msg: "Import started", importType: "sessions", source: "csv", eventId, userId: session.user.id, rowCount: rows.length });

    const requestIp = getClientIp(req);
    const errors: string[] = [];
    let created = 0;
    let tracksCreated = 0;

    for (let i = 0; i < rows.length; i++) {
      const fields = rows[i];
      const rowNum = i + 2;

      const name = getField(fields, idx.name);
      const startTimeRaw = getField(fields, idx.startTime);
      const endTimeRaw = getField(fields, idx.endTime);

      if (!name || !startTimeRaw || !endTimeRaw) {
        errors.push(`Row ${rowNum}: missing required fields (name, startTime, endTime)`);
        continue;
      }

      const startTime = new Date(startTimeRaw);
      const endTime = new Date(endTimeRaw);

      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
        errors.push(`Row ${rowNum}: invalid date format (use ISO 8601, e.g. 2026-03-15T09:00:00Z)`);
        continue;
      }

      // Resolve track — create missing ones with max+1 sortOrder INSIDE the
      // create transaction (the M10 pattern; the old pre-counted cursor could
      // mint duplicate sortOrders after track deletions).
      let trackId: string | null = null;
      const trackName = getField(fields, idx.track);
      if (trackName) {
        const existingTrackId = trackByName.get(trackName.toLowerCase());
        if (existingTrackId) {
          trackId = existingTrackId;
        } else {
          const newTrack = await db.$transaction(async (tx) => {
            const max = await tx.track.aggregate({ where: { eventId }, _max: { sortOrder: true } });
            return tx.track.create({
              data: { eventId, name: trackName, sortOrder: (max._max.sortOrder ?? -1) + 1 },
            });
          });
          trackByName.set(trackName.toLowerCase(), newTrack.id);
          trackId = newTrack.id;
          tracksCreated++;
        }
      }

      // Resolve speakers
      const speakerEmailsRaw = getField(fields, idx.speakerEmails);
      const speakerIds: string[] = [];
      if (speakerEmailsRaw) {
        const emails = speakerEmailsRaw.split(";").map((e) => e.trim().toLowerCase()).filter(Boolean);
        for (const email of emails) {
          const sid = speakerByEmail.get(email);
          if (sid) {
            speakerIds.push(sid);
          } else {
            errors.push(`Row ${rowNum}: speaker "${email}" not found for this event`);
          }
        }
      }

      const statusRaw = getField(fields, idx.status)?.toUpperCase();
      const status = statusRaw && SESSION_STATUS_VALUES.has(statusRaw) ? (statusRaw as SessionStatus) : "SCHEDULED";
      // Lenient capacity parse (import semantics): 0 / negative / garbage →
      // uncapped, matching the old route's "0 means no cap" behaviour. A
      // valid positive integer is passed through and re-validated by the
      // service.
      const capacityRaw = getField(fields, idx.capacity);
      const capacityParsed = capacityRaw ? parseInt(capacityRaw, 10) : NaN;
      const capacity = Number.isInteger(capacityParsed) && capacityParsed >= 1 ? capacityParsed : null;

      // Delegate to the shared service — event-TZ date validation
      // (OUTSIDE_EVENT_DATES), time-range check, per-session audit row and
      // stats refresh all happen there. Rejections become row errors.
      const result = await createSession({
        eventId,
        userId: session.user.id,
        source: "rest",
        requestIp,
        name,
        startTime,
        endTime,
        description: getField(fields, idx.description) || null,
        location: getField(fields, idx.location) || null,
        capacity,
        trackId,
        status,
        speakerIds,
        suppressAdminNotification: true,
      });
      if (result.ok) {
        created++;
      } else {
        errors.push(`Row ${rowNum}: ${result.message}`);
      }
    }

    // ONE summary notification for the whole batch (per-row notifications are
    // suppressed above so a 60-row import doesn't page admins 60 times).
    if (created > 0) {
      notifyEventAdmins(eventId, {
        type: "REGISTRATION",
        title: "Agenda Imported",
        message: `${created} session${created === 1 ? "" : "s"} imported from CSV${tracksCreated > 0 ? ` (${tracksCreated} new track${tracksCreated === 1 ? "" : "s"})` : ""}`,
        link: `/events/${eventId}/agenda`,
      }).catch((err) => apiLogger.error({ err, eventId, msg: "import-sessions:notify-failed" }));
    }

    apiLogger.info({ msg: "Import complete", importType: "sessions", source: "csv", eventId, userId: session.user.id, created, tracksCreated, errorCount: errors.length });
    if (errors.length > 0) {
      apiLogger.warn({ msg: "Import errors", importType: "sessions", source: "csv", eventId, userId: session.user.id, errors: errors.slice(0, 50) });
    }

    return NextResponse.json({ created, tracksCreated, errors });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing sessions" });
    return NextResponse.json({ error: "Failed to import sessions" }, { status: 500 });
  }
}
