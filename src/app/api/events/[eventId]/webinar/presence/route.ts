import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/permissions/require-permission";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { readWebinarSettings } from "@/lib/webinar";
import { checkRateLimit } from "@/lib/security";
import { recordExport } from "@/lib/audit-data-transfer";
import { resolveTimezone } from "@/lib/event-time";
import { contentDisposition } from "@/lib/download-filename";
import {
  presenceReportCsv,
  presenceReportSummary,
  presenceSummaryFromGroups,
  timesJoined,
  type PresenceReportRow,
} from "@/lib/webinar/presence-report";

type RouteParams = { params: Promise<{ eventId: string }> };

// "Present right now" = a heartbeat within the last minute.
const PRESENT_WINDOW_MS = 60_000;

/** One report can be thousands of lines; this many registrations is beyond any webinar we run. */
const REPORT_MAX_ROWS = 20_000;

/**
 * Real-time lobby/live presence for the Webinar Console "Live now" card.
 * Returns registrants currently on the webinar page (heartbeat in the last
 * 60s), split lobby vs joined. This is OUR-page presence, distinct from the
 * authoritative post-event ZoomAttendance. Read-only: `webinar.analytics.read`,
 * the same key as the attendance GET.
 *
 * Two more views of the same record (Nov 16, 2026; presence-report.ts):
 *   ?view=summary   everyone who ever opened the page: counts and minutes, no names
 *   ?export=csv     one line per registration with name, email and minutes watched;
 *                   it carries emails, so it asks `webinar.attendance.export`, the
 *                   key of the Zoom attendance CSV, with the same limit and audit
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const route = "events/[eventId]/webinar/presence:GET";
    const orgGuard = requireOrgId(session, { route });
    if ("error" in orgGuard) return orgGuard.error;
    const url = new URL(req.url);
    const exportCsv = url.searchParams.get("export") === "csv";
    const summaryOnly = url.searchParams.get("view") === "summary";
    const gate = exportCsv
      ? requirePermission(session, "webinar.attendance.export", { route, eventId })
      : requirePermission(session, "webinar.analytics.read", { route, eventId, onMissing: "hide" });
    if (!gate.ok) return gate.response;

    if (exportCsv) {
      const { allowed, retryAfterSeconds } = checkRateLimit({
        key: `webinar-presence-export:${session.user.id}`,
        limit: 30,
        windowMs: 3600_000,
      });
      if (!allowed) {
        apiLogger.warn({ eventId, userId: session.user.id, retryAfterSeconds }, "webinar-presence:export-rate-limited");
        return NextResponse.json(
          { error: "Too many exports. Try again later.", retryAfterSeconds, limit: 30, windowSeconds: 3600 },
          { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
        );
      }
    }

    return await runWithTenant(orgGuard.orgId, async () => {
    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true, settings: true, timezone: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const webinar = readWebinarSettings(event.settings);
    const anchorSessionId = webinar?.sessionId;
    if (!anchorSessionId) {
      if (exportCsv) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-presence:export-no-anchor-session");
        return NextResponse.json({ error: "This webinar has no session yet." }, { status: 409 });
      }
      // No webinar session yet — return an empty roster rather than an error so
      // the card renders a clean empty state.
      if (summaryOnly) return NextResponse.json(presenceReportSummary([]));
      return NextResponse.json({ lobby: 0, joined: 0, total: 0, rows: [] });
    }

    if (exportCsv || summaryOnly) {
      return await presenceReport(req, {
        exportCsv,
        eventId,
        sessionId: anchorSessionId,
        timezone: resolveTimezone(event.timezone),
        organizationId: orgGuard.orgId,
        userId: session.user.id,
        role: session.user.role,
      });
    }

    const cutoff = new Date(Date.now() - PRESENT_WINDOW_MS);
    const rows = await db.webinarPresence.findMany({
      // eventId binds the roster to THIS org-verified event (multi-tenancy sweep).
      where: { sessionId: anchorSessionId, eventId, lastSeenAt: { gte: cutoff } },
      select: {
        id: true,
        phase: true,
        firstJoinedAt: true,
        lastSeenAt: true,
        joinCount: true,
        registration: {
          select: {
            serialId: true,
            attendee: { select: { firstName: true, lastName: true, email: true } },
          },
        },
      },
      orderBy: { lastSeenAt: "desc" },
      take: 1000,
    });

    const mapped = rows.map((r) => ({
      id: r.id,
      phase: r.phase,
      name: `${r.registration.attendee?.firstName ?? ""} ${r.registration.attendee?.lastName ?? ""}`.trim() || "Attendee",
      email: r.registration.attendee?.email ?? null,
      serialId: r.registration.serialId,
      firstJoinedAt: r.firstJoinedAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      joinCount: r.joinCount,
    }));

    const joined = mapped.filter((r) => r.phase === "joined").length;
    const lobby = mapped.length - joined;

    return NextResponse.json({ lobby, joined, total: mapped.length, rows: mapped });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar:presence-fetch-failed");
    return NextResponse.json({ error: "Failed to load presence" }, { status: 500 });
  }
}

// No-store on both: the CSV is personal data, and the summary changes by the minute during a webinar.
const NO_STORE = { "Cache-Control": "private, no-store" };

function warnIfCapped(eventId: string, count: number): void {
  if (count === REPORT_MAX_ROWS) apiLogger.warn({ eventId, rows: count }, "webinar-presence:report-row-cap-reached");
}

/** The whole record of the webinar page, as a summary (no names) or the CSV. */
async function presenceReport(
  req: Request,
  at: { exportCsv: boolean; eventId: string; sessionId: string; timezone: string; organizationId: string; userId: string; role: string },
): Promise<NextResponse> {
  // eventId binds the record to THIS org-verified event, as the live roster does.
  const where = { sessionId: at.sessionId, eventId: at.eventId };
  if (!at.exportCsv) {
    // Counted by the database: no names, no row cap, and cheap for a console polling every minute
    // (review of 0b3f34ad: it loaded every row to add them up).
    const groups = await db.webinarPresence.groupBy({
      by: ["phase"],
      where,
      _count: { _all: true },
      _sum: { watchedSeconds: true },
    });
    return NextResponse.json(presenceSummaryFromGroups(groups), { headers: NO_STORE });
  }

  const found = await db.webinarPresence.findMany({
    where,
    select: {
      phase: true,
      firstJoinedAt: true,
      lastSeenAt: true,
      joinCount: true,
      watchedSeconds: true,
      registration: {
        select: { serialId: true, attendee: { select: { firstName: true, lastName: true, email: true } } },
      },
    },
    orderBy: { firstJoinedAt: "asc" },
    take: REPORT_MAX_ROWS,
  });
  warnIfCapped(at.eventId, found.length);
  const rows: PresenceReportRow[] = found.map((r) => ({
    name: `${r.registration.attendee?.firstName ?? ""} ${r.registration.attendee?.lastName ?? ""}`.trim() || "Attendee",
    email: r.registration.attendee?.email ?? null,
    serialId: r.registration.serialId,
    firstJoinedAt: r.firstJoinedAt,
    lastSeenAt: r.lastSeenAt,
    timesJoined: timesJoined(r),
    watchedSeconds: r.watchedSeconds,
    phase: r.phase,
  }));
  recordExport(req, {
    entityType: "WebinarPresence",
    eventId: at.eventId,
    organizationId: at.organizationId,
    userId: at.userId,
    role: at.role,
    rowCount: rows.length,
    format: "csv",
  });
  apiLogger.info({ eventId: at.eventId, userId: at.userId, rowCount: rows.length }, "webinar-presence:export-completed");
  return new NextResponse(presenceReportCsv(rows, at.timezone), {
    status: 200,
    headers: {
      ...NO_STORE,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDisposition(`webinar-page-attendance-${at.eventId}.csv`),
    },
  });
}
