import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordImport } from "@/lib/audit-data-transfer";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { parseCSV, getField } from "@/lib/csv-parser";
import { resolveTimezone, wallTimeInTzToDate } from "@/lib/event-time";
import { notifyEventAdmins } from "@/lib/notifications";
import { SessionStatus as PrismaSessionStatus, type SessionType } from "@prisma/client";
import {
  appendSessionTopics,
  createSession,
  type AppendSessionTopicInput,
  type SessionRole,
  type SessionStatus,
} from "@/services/session-service";
import { isBreakSessionType } from "@/lib/session-enums";

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
  "WORKSHOP": "WORKSHOP",
  "SYMPOSIUM": "SYMPOSIUM",
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

/** One topic read from a row's topicTitle / topicDuration / topicSpeakerEmails. */
interface TopicDraft extends AppendSessionTopicInput {
  rowNum: number;
}

/**
 * Every row sharing a name + start time is ONE session. The first row carries
 * the session's own columns (end time, track, people, type); each row with a
 * topicTitle adds one topic, in file order.
 */
interface SessionGroup {
  key: string;
  rowNum: number;
  name: string;
  startTime: Date;
  fields: string[];
  rowCount: number;
  /** Later rows naming no topic: the same session written twice. */
  repeatRows: number;
  topics: TopicDraft[];
}

const ROLE_COLUMNS = [
  { column: "speakerEmails", role: "SPEAKER", label: "speaker" },
  { column: "moderatorEmails", role: "MODERATOR", label: "moderator" },
  { column: "chairEmails", role: "CHAIRPERSON", label: "chairperson" },
] as const satisfies readonly { column: string; role: SessionRole; label: string }[];

const splitEmails = (raw: string | undefined) =>
  (raw ?? "").split(";").map((e) => e.trim().toLowerCase()).filter(Boolean);

/**
 * Agenda CSV import. Each row delegates to `session-service.createSession()`
 * — the ONE create implementation shared with the dashboard REST POST and
 * MCP `create_session` — so imported sessions get the same event-timezone
 * date validation (OUTSIDE_EVENT_DATES), capacity rules, audit rows and
 * stats refresh as every other create path (this route used to be a raw
 * `db.eventSession.create` that predated the July 16 service extraction).
 * Per-row notifications are suppressed; ONE summary notification is sent
 * for the batch instead.
 *
 * Topics (Nov 12, 2026): rows sharing a name + start time are one session and
 * each row's optional topicTitle / topicDuration / topicSpeakerEmails adds a
 * topic to it. A session already on the event is never changed; the topics it
 * does not hold yet are added through `appendSessionTopics`, so the same file
 * imported twice adds nothing the second time.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const gate = requirePermission(session, "sessions.write", { route: "events/[eventId]/import/sessions:POST", eventId });
    if (!gate.ok) return gate.response;

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
      moderatorEmails: headers.indexOf("moderatoremails"),
      chairEmails: headers.indexOf("chairemails"),
      status: headers.indexOf("status"),
      type: headers.indexOf("type"),
      topicTitle: headers.indexOf("topictitle"),
      topicDuration: headers.indexOf("topicduration"),
      topicSpeakerEmails: headers.indexOf("topicspeakeremails"),
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
      where: gate.eventWhere,
      select: { id: true, timezone: true, organizationId: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "events/import-sessions:event-access-denied", eventId, userId: session.user.id, role: session.user.role });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // The event's org (RESOURCE org) opens the tenant wrap around every swept
    // track/session read+write below.
    return await runWithTenant(event.organizationId, async () => {
    // Load existing tracks, speakers, and sessions for this event
    const [existingTracks, existingSpeakers, existingSessions] = await Promise.all([
      db.track.findMany({ where: { eventId }, select: { id: true, name: true } }),
      db.speaker.findMany({ where: { eventId }, select: { id: true, email: true } }),
      db.eventSession.findMany({ where: { eventId }, select: { id: true, name: true, startTime: true, type: true } }),
    ]);

    const trackByName = new Map(existingTracks.map((t) => [t.name.toLowerCase(), t.id]));
    const speakerByEmail = new Map(existingSpeakers.map((s) => [s.email.toLowerCase(), s.id]));

    // Re-import safety: an identical (name, startTime) already on the event is
    // never created again, so iterating on a multi-day programme in Excel and
    // re-importing the corrected file cannot double the agenda. Kept as a LIST
    // per key: two sessions made by hand can share a name and a start time, and
    // a topic must never be added to a guess between them.
    const eventTz = resolveTimezone(event.timezone);
    const sessionKey = (name: string, start: Date) => `${name.toLowerCase()}|${start.getTime()}`;
    const existingByKey = new Map<string, { id: string; type: SessionType }[]>();
    for (const es of existingSessions) {
      const key = sessionKey(es.name, es.startTime);
      existingByKey.set(key, [...(existingByKey.get(key) ?? []), { id: es.id, type: es.type }]);
    }

    apiLogger.info({ msg: "Import started", importType: "sessions", source: "csv", eventId, userId: session.user.id, rowCount: rows.length });

    const requestIp = getClientIp(req);
    // Collected with their row so the report reads in file order although the
    // topics are read in one pass and the sessions written in the next.
    const rowErrors: { rowNum: number; message: string }[] = [];
    const rowError = (rowNum: number, message: string) => rowErrors.push({ rowNum, message: `Row ${rowNum}: ${message}` });
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let tracksCreated = 0;
    let topicsCreated = 0;

    const resolveEmails = (raw: string | undefined, rowNum: number): string[] => {
      const ids: string[] = [];
      for (const email of splitEmails(raw)) {
        const sid = speakerByEmail.get(email);
        if (sid) ids.push(sid);
        else rowError(rowNum, `speaker "${email}" not found for this event`);
      }
      return ids;
    };

    const hasTopicCells = (fields: string[]) =>
      [idx.topicTitle, idx.topicDuration, idx.topicSpeakerEmails].some((i) => getField(fields, i));

    // The topic a row carries, if any. Problems are row errors; a bad duration
    // or an unknown speaker still imports the topic without that value, the
    // same way an unknown session speaker never costs the session.
    const readTopic = (fields: string[], rowNum: number): TopicDraft | null => {
      const title = getField(fields, idx.topicTitle);
      const durationRaw = getField(fields, idx.topicDuration);
      const speakersRaw = getField(fields, idx.topicSpeakerEmails);
      if (!title) {
        if (durationRaw || speakersRaw) rowError(rowNum, "topicDuration and topicSpeakerEmails need a topicTitle on the same row");
        return null;
      }
      let duration: number | null = null;
      if (durationRaw) {
        const minutes = Number(durationRaw);
        if (Number.isInteger(minutes) && minutes >= 1) duration = minutes;
        else rowError(rowNum, `topicDuration "${durationRaw}" is not a whole number of minutes; topic "${title}" has no duration`);
      }
      return { rowNum, title, duration, speakerIds: resolveEmails(speakersRaw, rowNum) };
    };

    // ── Pass 1: read the rows into sessions and their topics ────────────────
    const groups = new Map<string, SessionGroup>();
    for (let i = 0; i < rows.length; i++) {
      const fields = rows[i];
      const rowNum = i + 2;

      const name = getField(fields, idx.name);
      const startTimeRaw = getField(fields, idx.startTime);
      if (!name || !startTimeRaw) {
        rowError(rowNum, "missing required fields (name, startTime, endTime)");
        continue;
      }
      const startTime = parseImportDate(startTimeRaw, eventTz);
      if (isNaN(startTime.getTime())) {
        rowError(rowNum, "invalid date format (use ISO 8601, e.g. 2026-03-15T09:00:00 — interpreted in the event's timezone unless you add Z or a +HH:MM offset)");
        continue;
      }

      const key = sessionKey(name, startTime);
      const group = groups.get(key) ?? { key, rowNum, name, startTime, fields, rowCount: 0, repeatRows: 0, topics: [] };
      groups.set(key, group);
      group.rowCount++;
      const topic = readTopic(fields, rowNum);
      if (topic) group.topics.push(topic);
      else if (group.rowCount > 1 && !hasTopicCells(fields)) group.repeatRows++;
    }

    // A session already on the event: left as it is, and given the topics it
    // does not hold yet. Rows that add nothing count as skipped.
    const addToExisting = async (group: SessionGroup, matches: { id: string; type: SessionType }[]) => {
      if (group.topics.length === 0) {
        skipped += group.rowCount;
        return;
      }
      if (matches.length > 1) {
        rowError(group.rowNum, `${matches.length} sessions on the event are named "${group.name}" and start at this time, so its topics were not added. Add them in the session's own dialog.`);
        return;
      }
      const [match] = matches;
      if (isBreakSessionType(match.type)) {
        rowError(group.rowNum, `"${group.name}" is a break item on the event and cannot have topics`);
        return;
      }
      const result = await appendSessionTopics({
        eventId,
        organizationId: event.organizationId,
        sessionId: match.id,
        actorUserId: session.user.id,
        source: "rest",
        requestIp,
        topics: group.topics.map(({ title, duration, speakerIds }) => ({ title, duration, speakerIds })),
        onlyMissingTitles: true,
      });
      if (!result.ok) {
        rowError(group.rowNum, `${result.message} (topics for "${group.name}" were not added)`);
        return;
      }
      topicsCreated += result.added.length;
      skipped += group.rowCount - result.added.length;
      if (result.added.length > 0) updated++;
    };

    // The session's own people, from the FIRST row of its group. One person
    // under two role columns is refused here, in the file's words; the service
    // would refuse it too, in the dashboard's.
    const readSessionRoles = (group: SessionGroup): { speakerId: string; role: SessionRole }[] | null => {
      const roleByEmail = new Map<string, (typeof ROLE_COLUMNS)[number]>();
      for (const col of ROLE_COLUMNS) {
        for (const email of splitEmails(getField(group.fields, idx[col.column]))) {
          const prev = roleByEmail.get(email);
          if (prev && prev.role !== col.role) {
            rowError(group.rowNum, `"${email}" is listed as both ${prev.label} and ${col.label}, and a person holds one role per session. To have a moderator or chairperson speak as well, name them in topicSpeakerEmails. Session not imported.`);
            return null;
          }
          roleByEmail.set(email, col);
        }
      }
      const roles: { speakerId: string; role: SessionRole }[] = [];
      for (const [email, col] of roleByEmail) {
        const sid = speakerByEmail.get(email);
        if (sid) roles.push({ speakerId: sid, role: col.role });
        else rowError(group.rowNum, `speaker "${email}" not found for this event`);
      }
      return roles;
    };

    // Resolve the track, creating a missing one with max+1 sortOrder INSIDE
    // the create transaction (the M10 pattern; the old pre-counted cursor could
    // mint duplicate sortOrders after track deletions).
    const resolveTrackId = async (trackName: string | undefined): Promise<string | null> => {
      if (!trackName) return null;
      const existingTrackId = trackByName.get(trackName.toLowerCase());
      if (existingTrackId) return existingTrackId;
      const newTrack = await tenantTransaction(async (tx) => {
        const max = await tx.track.aggregate({ where: { eventId }, _max: { sortOrder: true } });
        return tx.track.create({
          data: { eventId, organizationId: event.organizationId, name: trackName, sortOrder: (max._max.sortOrder ?? -1) + 1 },
        });
      });
      trackByName.set(trackName.toLowerCase(), newTrack.id);
      tracksCreated++;
      return newTrack.id;
    };

    const createFromGroup = async (group: SessionGroup) => {
      const { fields, rowNum, name, startTime } = group;
      const lostTopics = group.topics.length > 0 ? ` (its ${group.topics.length} topic${group.topics.length === 1 ? " was" : "s were"} not imported)` : "";

      const endTimeRaw = getField(fields, idx.endTime);
      if (!endTimeRaw) {
        rowError(rowNum, `missing required fields (name, startTime, endTime)${lostTopics}`);
        return;
      }
      const endTime = parseImportDate(endTimeRaw, eventTz);
      if (isNaN(endTime.getTime())) {
        rowError(rowNum, `invalid date format (use ISO 8601, e.g. 2026-03-15T09:00:00 — interpreted in the event's timezone unless you add Z or a +HH:MM offset)${lostTopics}`);
        return;
      }

      // Optional type column: SESSION (default) or a break item.
      const typeRaw = getField(fields, idx.type)?.trim().toUpperCase();
      let sessionType: SessionType = "SESSION";
      if (typeRaw) {
        const mapped = SESSION_TYPE_ALIASES[typeRaw];
        if (!mapped) {
          rowError(rowNum, `unknown type "${typeRaw}" — use SESSION, WORKSHOP, SYMPOSIUM, REGISTRATION, BREAK (or "Coffee Break"), LUNCH, or NETWORKING${lostTopics}`);
          return;
        }
        sessionType = mapped;
      }
      // Break items are track-less by design — a track value on a break row
      // is ignored (documented in the import dialog). Speakers and topics on a
      // break row are NOT ignored: the service rejects the row with a clear error.
      const isBreakRow = sessionType !== "SESSION";

      const sessionRoles = readSessionRoles(group);
      if (!sessionRoles) return;

      const trackId = isBreakRow ? null : await resolveTrackId(getField(fields, idx.track));

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
        organizationId: event.organizationId,
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
        sessionRoles,
        topics: group.topics.map(({ title, duration, speakerIds }, sortOrder) => ({ title, duration, speakerIds, sortOrder })),
        suppressAdminNotification: true,
      });
      if (!result.ok) {
        rowError(rowNum, `${result.message}${lostTopics}`);
        return;
      }
      created++;
      topicsCreated += group.topics.length;
      skipped += group.repeatRows;
    };

    // ── Pass 2: write each session once, in file order ──────────────────────
    for (const group of groups.values()) {
      const matches = existingByKey.get(group.key);
      if (matches) await addToExisting(group, matches);
      else await createFromGroup(group);
    }

    const errors = rowErrors.sort((a, b) => a.rowNum - b.rowNum).map((e) => e.message);

    // ONE summary notification for the whole batch (per-row notifications are
    // suppressed above so a 60-row import doesn't page admins 60 times).
    if (created > 0) {
      notifyEventAdmins(eventId, {
        type: "REGISTRATION",
        title: "Agenda Imported",
        message: `${created} session${created === 1 ? "" : "s"} imported from CSV${topicsCreated > 0 ? ` with ${topicsCreated} topic${topicsCreated === 1 ? "" : "s"}` : ""}${tracksCreated > 0 ? ` (${tracksCreated} new track${tracksCreated === 1 ? "" : "s"})` : ""}`,
        link: `/events/${eventId}/agenda`,
      }).catch((err) => apiLogger.error({ err, eventId, msg: "import-sessions:notify-failed" }));
    }

    apiLogger.info({ msg: "Import complete", importType: "sessions", source: "csv", eventId, userId: session.user.id, created, updated, skipped, tracksCreated, topicsCreated, errorCount: errors.length });
    if (errors.length > 0) {
      apiLogger.warn({ msg: "Import errors", importType: "sessions", source: "csv", eventId, userId: session.user.id, errors: errors.slice(0, 50) });
    }

    recordImport(req, {
      entityType: "EventSession",
      eventId,
      organizationId: session.user.organizationId,
      userId: session.user.id,
      role: session.user.role,
      totalProcessed: rows.length,
      created,
      updated,
      skipped,
      errors: errors.length,
      format: "csv",
    });

    return NextResponse.json({ created, updated, skipped, tracksCreated, topicsCreated, errors });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing sessions" });
    return NextResponse.json({ error: "Failed to import sessions" }, { status: 500 });
  }
}
