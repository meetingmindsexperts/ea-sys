import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { readWebinarSettings } from "@/lib/webinar";
import { syncWebinarAttendance } from "@/lib/webinar-attendance";

type RouteParams = { params: Promise<{ eventId: string }> };

interface AttendeeRow {
  id: string;
  name: string;
  email: string | null;
  joinTime: string;
  leaveTime: string | null;
  durationSeconds: number;
  attentivenessScore: number | null;
  registrationId: string | null;
  registrationSerialId: number | null;
}

interface AttendanceKpis {
  registered: number;
  attended: number;
  attendanceRate: number;
  avgWatchSeconds: number;
  totalWatchSeconds: number;
  peakConcurrent: number;
  lastSyncedAt: string | null;
}

/**
 * Compute peak concurrent attendees by walking a sorted list of join/leave
 * events. O(n log n) — fine for thousands of rows. Used for the KPI card.
 */
function computePeakConcurrent(
  rows: Array<{ joinTime: Date; leaveTime: Date | null }>,
): number {
  if (rows.length === 0) return 0;
  type Edge = { time: number; delta: number };
  const edges: Edge[] = [];
  for (const r of rows) {
    edges.push({ time: r.joinTime.getTime(), delta: 1 });
    if (r.leaveTime) {
      edges.push({ time: r.leaveTime.getTime(), delta: -1 });
    }
  }
  // Sort by time, with -1 (leave) before +1 (join) at the same instant so
  // back-to-back leave/rejoin doesn't double-count.
  edges.sort((a, b) => a.time - b.time || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const e of edges) {
    current += e.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

/**
 * Escape a field for CSV output per RFC 4180.
 */
function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ── GET — return KPIs + attendees + (optionally) CSV export ─────────

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const exportCsv = url.searchParams.get("export") === "csv";

    // Verify access + locate anchor session via parallel queries
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, name: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const webinar = readWebinarSettings(event.settings);
    const anchorSessionId = webinar?.sessionId;
    if (!anchorSessionId) {
      return NextResponse.json(
        { error: "No anchor session. Run the webinar provisioner first." },
        { status: 400 },
      );
    }

    const [zoomMeeting, attendances, registrationsCount] = await Promise.all([
      db.zoomMeeting.findUnique({
        where: { sessionId: anchorSessionId },
        select: { id: true, lastAttendanceSyncAt: true },
      }),
      db.zoomAttendance.findMany({
        where: { eventId, sessionId: anchorSessionId },
        orderBy: [{ joinTime: "asc" }],
        select: {
          id: true,
          name: true,
          email: true,
          joinTime: true,
          leaveTime: true,
          durationSeconds: true,
          attentivenessScore: true,
          registrationId: true,
          registration: {
            select: { serialId: true },
          },
        },
      }),
      db.registration.count({
        where: { eventId, status: { in: ["CONFIRMED", "CHECKED_IN"] } },
      }),
    ]);

    const totalWatchSeconds = attendances.reduce(
      (sum, a) => sum + a.durationSeconds,
      0,
    );
    const uniqueAttendees = new Set<string>();
    for (const a of attendances) {
      uniqueAttendees.add(a.email?.toLowerCase() || `id:${a.id}`);
    }
    const attendedCount = uniqueAttendees.size;

    const kpis: AttendanceKpis = {
      registered: registrationsCount,
      attended: attendedCount,
      attendanceRate:
        registrationsCount > 0 ? Math.round((attendedCount / registrationsCount) * 100) : 0,
      avgWatchSeconds:
        attendances.length > 0 ? Math.round(totalWatchSeconds / attendances.length) : 0,
      totalWatchSeconds,
      peakConcurrent: computePeakConcurrent(attendances),
      lastSyncedAt: zoomMeeting?.lastAttendanceSyncAt?.toISOString() ?? null,
    };

    const rows: AttendeeRow[] = attendances.map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email,
      joinTime: a.joinTime.toISOString(),
      leaveTime: a.leaveTime?.toISOString() ?? null,
      durationSeconds: a.durationSeconds,
      attentivenessScore: a.attentivenessScore,
      registrationId: a.registrationId,
      registrationSerialId: a.registration?.serialId ?? null,
    }));

    if (exportCsv) {
      const header = [
        "Name",
        "Email",
        "Join Time",
        "Leave Time",
        "Duration (min)",
        "Attentiveness",
        "Registration #",
      ];
      const lines = [header.map(csvField).join(",")];
      for (const r of rows) {
        lines.push(
          [
            r.name,
            r.email,
            r.joinTime,
            r.leaveTime,
            Math.round(r.durationSeconds / 60),
            r.attentivenessScore,
            r.registrationSerialId
              ? String(r.registrationSerialId).padStart(3, "0")
              : null,
          ]
            .map(csvField)
            .join(","),
        );
      }
      const csv = lines.join("\n");
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="webinar-attendance-${event.id}.csv"`,
        },
      });
    }

    return NextResponse.json({ kpis, rows });
  } catch (err) {
    apiLogger.error({ err }, "webinar-attendance:list-failed");
    return NextResponse.json(
      { error: "Failed to load attendance" },
      { status: 500 },
    );
  }
}

// ── POST — manual attendance re-sync ────────────────────────────────

export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-attendance-sync:${eventId}`,
      limit: 10,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn(
        { eventId, userId: session.user.id },
        "webinar-attendance:rate-limited",
      );
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const webinar = readWebinarSettings(event.settings);
    const anchorSessionId = webinar?.sessionId;
    if (!anchorSessionId) {
      apiLogger.warn(
        { eventId, userId: session.user.id },
        "webinar-attendance:manual-sync-no-anchor-session",
      );
      return NextResponse.json(
        { error: "No anchor session. Run the webinar provisioner first." },
        { status: 400 },
      );
    }

    const zoomMeeting = await db.zoomMeeting.findUnique({
      where: { sessionId: anchorSessionId },
      select: { id: true },
    });
    if (!zoomMeeting) {
      apiLogger.warn(
        { eventId, anchorSessionId, userId: session.user.id },
        "webinar-attendance:manual-sync-no-zoom-meeting",
      );
      return NextResponse.json(
        { error: "No Zoom webinar attached to the anchor session." },
        { status: 400 },
      );
    }

    const result = await syncWebinarAttendance(zoomMeeting.id);

    apiLogger.info(
      {
        eventId,
        zoomMeetingDbId: zoomMeeting.id,
        status: result.status,
        userId: session.user.id,
      },
      "webinar-attendance:manual-sync",
    );

    return NextResponse.json(result);
  } catch (err) {
    apiLogger.error({ err }, "webinar-attendance:manual-sync-failed");
    return NextResponse.json(
      { error: "Failed to sync attendance" },
      { status: 500 },
    );
  }
}
