import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { parseCSV, getField } from "@/lib/csv-parser";
import { resolveTimezone, wallTimeInTzToDate } from "@/lib/event-time";
import { notifyEventAdmins } from "@/lib/notifications";
import { SessionStatus as PrismaSessionStatus, type SessionType } from "@prisma/client";
import { createSession, type SessionStatus } from "@/services/session-service";

// Derived from the Prisma enum — a new status can't silently drift out of
// the CSV whitelist.
const SESSION_STATUS_VALUES = new Set<string>(Object.values(PrismaSessionStatus));

// Explicit-offset detector: "…Z" or "…+04:00" / "…-0500". A timezone-NAIVE
// datetime ("2026-06-15T09:00:00" — how organizers author a programme in
// Excel) is interpreted as WALL-CLOCK TIME IN THE EVENT'S TIMEZONE, matching
// the dashboard form. Bare `new Date()` used to parse it in the SERVER's
// timezone (UTC in prod), silently shifting a Dubai 9 AM session to 1 PM.
const HAS_EXPLICIT_OFFSET_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

function parseImportDate(raw: string, eventTz: string): Date {
  if (HAS_EXPLICIT_OFFSET_RE.test(raw)) return new Date(raw);
  return wallTimeInTzToDate(raw, eventTz);
}

// Optional `type` column → break items. Friendly aliases so an organizer's
// natural spelling ("Coffee Break") maps without memorizing enum values; an
// unrecognized value is a ROW ERROR, never a silent default (a typo'd type
// would otherwise silently flip how the agenda renders the row).
const SESSION_TYPE_ALIASES: Record<string, SessionType> = {
  "SESSION": "SESSION",
  "REGISTRATION": "REGISTRATION",
  "BREAK": "BREAK",
  "COFFEE": "BREAK",
  "COFFEE BREAK": "BREAK",
  "LUNCH": "LUNCH",
  "LUNCH BREAK": "LUNCH",
  "NETWORKING": "NETWORKING",
};

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
      type: headers.indexOf("type"),
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
      select: { id: true, timezone: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "events/import-sessions:event-access-denied", eventId, userId: session.user.id, role: session.user.role });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Load existing tracks, speakers, and sessions for this event
    const [existingTracks, existingSpeakers, existingSessions] = await Promise.all([
      db.track.findMany({ where: { eventId }, select: { id: true, name: true } }),
      db.speaker.findMany({ where: { eventId }, select: { id: true, email: true } }),
      db.eventSession.findMany({ where: { eventId }, select: { name: true, startTime: true } }),
    ]);

    const trackByName = new Map(existingTracks.map((t) => [t.name.toLowerCase(), t.id]));
    const speakerByEmail = new Map(existingSpeakers.map((s) => [s.email.toLowerCase(), s.id]));

    // Re-import safety: an identical (name, startTime) already on the event is
    // SKIPPED, not duplicated — iterating on a multi-day programme in Excel and
    // re-importing the corrected file must not double the agenda. Newly created
    // rows join the set so in-file duplicate rows are caught too.
    const eventTz = resolveTimezone(event.timezone);
    const sessionKey = (name: string, start: Date) => `${name.toLowerCase()}|${start.getTime()}`;
    const existingSessionKeys = new Set(existingSessions.map((es) => sessionKey(es.name, es.startTime)));

    apiLogger.info({ msg: "Import started", importType: "sessions", source: "csv", eventId, userId: session.user.id, rowCount: rows.length });

    const requestIp = getClientIp(req);
    const errors: string[] = [];
    let created = 0;
    let skipped = 0;
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

      const startTime = parseImportDate(startTimeRaw, eventTz);
      const endTime = parseImportDate(endTimeRaw, eventTz);

      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
        errors.push(`Row ${rowNum}: invalid date format (use ISO 8601, e.g. 2026-03-15T09:00:00 — interpreted in the event's timezone unless you add Z or a +HH:MM offset)`);
        continue;
      }

      if (existingSessionKeys.has(sessionKey(name, startTime))) {
        skipped++;
        continue;
      }

      // Optional type column: SESSION (default) or a break item.
      const typeRaw = getField(fields, idx.type)?.trim().toUpperCase();
      let sessionType: SessionType = "SESSION";
      if (typeRaw) {
        const mapped = SESSION_TYPE_ALIASES[typeRaw];
        if (!mapped) {
          errors.push(
            `Row ${rowNum}: unknown type "${typeRaw}" — use SESSION, REGISTRATION, BREAK (or "Coffee Break"), LUNCH, or NETWORKING`,
          );
          continue;
        }
        sessionType = mapped;
      }
      // Break items are track-less by design — a track value on a break row
      // is ignored (documented in the import dialog). Speakers on a break row
      // are NOT ignored: the service rejects the row with a clear error.
      const isBreakRow = sessionType !== "SESSION";

      // Resolve track — create missing ones with max+1 sortOrder INSIDE the
      // create transaction (the M10 pattern; the old pre-counted cursor could
      // mint duplicate sortOrders after track deletions).
      let trackId: string | null = null;
      const trackName = getField(fields, idx.track);
      if (trackName && !isBreakRow) {
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
        capacity: isBreakRow ? null : capacity,
        trackId,
        status,
        type: sessionType,
        speakerIds,
        suppressAdminNotification: true,
      });
      if (result.ok) {
        created++;
        existingSessionKeys.add(sessionKey(name, startTime));
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

    apiLogger.info({ msg: "Import complete", importType: "sessions", source: "csv", eventId, userId: session.user.id, created, skipped, tracksCreated, errorCount: errors.length });
    if (errors.length > 0) {
      apiLogger.warn({ msg: "Import errors", importType: "sessions", source: "csv", eventId, userId: session.user.id, errors: errors.slice(0, 50) });
    }

    return NextResponse.json({ created, skipped, tracksCreated, errors });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing sessions" });
    return NextResponse.json({ error: "Failed to import sessions" }, { status: 500 });
  }
}
