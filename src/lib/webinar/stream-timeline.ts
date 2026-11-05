/**
 * The webinar stream timeline (Nov 5, 2026): what happened to the room and the
 * stream, in order, for the console's Stream timeline card. Room opened or
 * closed, Start or Stop stream pressed, the stream seen live or dropped, and
 * the watchdog's automatic restarts.
 *
 * Stored as AuditLog rows (action WEBINAR_STREAM), not a table of its own: the
 * audit table already carries the tenant column, its RLS policy and an
 * (eventId, action, createdAt) index, and the events are audit facts anyway.
 * Recording never throws: a timeline row must never stop the room or the
 * stream it describes.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

export const STREAM_TIMELINE_ACTION = "WEBINAR_STREAM";

export const STREAM_EVENT_KINDS = [
  "ROOM_OPENED",
  "ROOM_CLOSED",
  "ROOM_AUTO_CLOSED",
  "STREAM_START_PRESSED",
  "STREAM_STOP_PRESSED",
  "STREAM_LIVE",
  "STREAM_DROPPED",
  "AUTO_RESTART_REQUESTED",
  "AUTO_RESTART_FAILED",
] as const;
export type StreamEventKind = (typeof STREAM_EVENT_KINDS)[number];

export interface StreamTimelineEntry {
  id: string;
  kind: StreamEventKind;
  at: string;
  /** Who pressed it; null for the worker and for observations. */
  user: { firstName: string; lastName: string } | null;
  detail: string | null;
}

export async function recordStreamEvent(input: {
  organizationId: string;
  eventId: string;
  sessionId: string;
  kind: StreamEventKind;
  userId?: string | null;
  /** A short human line (a Zoom refusal, the close reason). */
  detail?: string | null;
  source: "rest" | "worker";
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        userId: input.userId ?? null,
        action: STREAM_TIMELINE_ACTION,
        entityType: "EventSession",
        entityId: input.sessionId,
        changes: { kind: input.kind, source: input.source, ...(input.detail ? { detail: input.detail.slice(0, 300) } : {}) },
      },
    });
  } catch (err) {
    apiLogger.error({ err, eventId: input.eventId, kind: input.kind }, "webinar-stream-timeline:record-failed");
  }
}

function isKind(v: unknown): v is StreamEventKind {
  return typeof v === "string" && (STREAM_EVENT_KINDS as readonly string[]).includes(v);
}

/** The newest entries for one webinar's room, newest first. */
export async function listStreamEvents(eventId: string, sessionId: string, limit = 100): Promise<StreamTimelineEntry[]> {
  const rows = await db.auditLog.findMany({
    where: { eventId, action: STREAM_TIMELINE_ACTION, entityId: sessionId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      createdAt: true,
      changes: true,
      user: { select: { firstName: true, lastName: true } },
    },
  });
  const out: StreamTimelineEntry[] = [];
  for (const row of rows) {
    const changes = (row.changes && typeof row.changes === "object" ? row.changes : {}) as Record<string, unknown>;
    if (!isKind(changes.kind)) continue;
    out.push({
      id: row.id,
      kind: changes.kind,
      at: row.createdAt.toISOString(),
      user: row.user ?? null,
      detail: typeof changes.detail === "string" ? changes.detail : null,
    });
  }
  return out;
}

/** Producer actions and room changes: each starts a fresh run for the watchdog. */
export const RUN_BOUNDARY_KINDS: readonly StreamEventKind[] = [
  "STREAM_START_PRESSED",
  "STREAM_STOP_PRESSED",
  "ROOM_OPENED",
  "ROOM_CLOSED",
  "ROOM_AUTO_CLOSED",
];

/**
 * Where the stream watchdog picks up after a worker restart: the last observation of the current run
 * (live, or dropped with how many automatic restarts since), or nothing. A producer action or a room
 * change ends the run, so a stale "live" from before a Stop and Start never reads as a drop, and a
 * restart of the worker does not hand a long outage a fresh budget of attempts (review of 439b4d8e).
 */
export async function lastStreamObservation(
  eventId: string,
  sessionId: string,
  since: Date | null,
): Promise<{ state: "up" | "down" | null; restarts: number }> {
  const rows = await db.auditLog.findMany({
    where: {
      eventId,
      action: STREAM_TIMELINE_ACTION,
      entityId: sessionId,
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { changes: true },
  });
  let restarts = 0;
  for (const row of rows) {
    const kind = (row.changes as Record<string, unknown> | null)?.kind;
    if (kind === "AUTO_RESTART_REQUESTED" || kind === "AUTO_RESTART_FAILED") restarts += 1;
    else if (kind === "STREAM_LIVE") return { state: "up", restarts: 0 };
    else if (kind === "STREAM_DROPPED") return { state: "down", restarts };
    else if (isKind(kind) && RUN_BOUNDARY_KINDS.includes(kind)) return { state: null, restarts: 0 };
  }
  return { state: null, restarts: 0 };
}

/** Whether a producer action or room change was recorded at or after `since` (the watchdog's re-check). */
export async function runBoundarySince(eventId: string, sessionId: string, since: Date): Promise<boolean> {
  const rows = await db.auditLog.findMany({
    where: { eventId, action: STREAM_TIMELINE_ACTION, entityId: sessionId, createdAt: { gte: since } },
    select: { changes: true },
    take: 20,
  });
  return rows.some((row) => {
    const kind = (row.changes as Record<string, unknown> | null)?.kind;
    return isKind(kind) && RUN_BOUNDARY_KINDS.includes(kind);
  });
}
