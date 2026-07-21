/**
 * Session service — domain logic for creating and updating an event session
 * (the program / agenda).
 *
 * Shared by the REST routes (`POST /api/events/[eventId]/sessions`,
 * `PUT /api/events/[eventId]/sessions/[sessionId]`) and the MCP agent tools
 * (`create_session`, `update_session`).
 *
 * WHY THIS EXISTS (program/agenda review, July 10 2026):
 *   - H4: the create/update bodies were hand-copied into the REST routes and
 *     the MCP executors, and had already drifted. MCP `create_session` wrote
 *     **no audit row** and sent **no admin notification** — every session made
 *     by the in-app agent or n8n was invisible in `AuditLog`. REST accepted
 *     `status`, session-level `abstractId` and topic `sortOrder`; MCP silently
 *     dropped all three. Capacity validation disagreed (REST `min(1)`, MCP
 *     `Math.max(0, …)`), and MCP `update_session` allowed a zero-duration
 *     session (`newEnd < newStart`) that every REST path rejected (`<=`).
 *   - H1: the REST PUT deleted and rebuilt every SessionSpeaker + SessionTopic
 *     **before** checking the optimistic lock, and did so non-transactionally.
 *     A stale write destroyed the other editor's roster and then returned 409
 *     "nothing was saved"; a mid-loop failure truncated the agenda.
 *
 * Both are fixed here, once: the lock is claimed FIRST and the parent update
 * plus both child replaces commit atomically or not at all.
 *
 * Scope is single create/update. The per-speaker MCP tools
 * (`add_speaker_to_session`, `remove_speaker_from_session`,
 * `replace_session_speakers`) keep their own executors — they are narrow,
 * already audited, and already transactional where it matters.
 *
 * See src/services/README.md for the conventions (errors-as-values,
 * already-typed input, service owns the transaction + side effects, never
 * imports from `next/server`).
 */

import { Prisma, type SessionType } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { refreshEventStats } from "@/lib/event-stats";
import { notifyEventAdmins } from "@/lib/notifications";
import { isBreakSessionType } from "@/lib/session-enums";
import { readWebinarSettings } from "@/lib/webinar";
import {
  isSessionWithinEventDates,
  localDateInTz,
  resolveTimezone,
} from "@/lib/event-time";

// ── Types ────────────────────────────────────────────────────────────────────

export type SessionRole = "SPEAKER" | "MODERATOR" | "CHAIRPERSON" | "PANELIST";
export type SessionStatus = "DRAFT" | "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";

export const SESSION_ROLES: readonly SessionRole[] = [
  "SPEAKER",
  "MODERATOR",
  "CHAIRPERSON",
  "PANELIST",
];

export interface SessionTopicInput {
  /**
   * Existing topic id — an update payload carrying it keeps the row (and its
   * cuid) instead of delete-and-recreate, so deep links / external syncs to a
   * topic id survive a session save (M2, program/agenda review). An id that
   * doesn't belong to this session is ignored and the topic created fresh.
   */
  id?: string | null;
  title: string;
  abstractId?: string | null;
  duration?: number | null;
  sortOrder?: number;
  speakerIds?: string[];
}

export interface SessionSpeakerInput {
  speakerId: string;
  role: SessionRole;
}

interface SessionFieldsInput {
  name?: string;
  description?: string | null;
  trackId?: string | null;
  abstractId?: string | null;
  startTime?: Date;
  endTime?: Date;
  location?: string | null;
  capacity?: number | null;
  status?: SessionStatus;
  /**
   * SESSION (default) or a break item (REGISTRATION / BREAK / LUNCH /
   * NETWORKING). A break item is a plain agenda time block: it may never
   * carry speakers, topics, or an abstract — see the BREAK_ITEM_HAS_PROGRAM
   * check in `validate`.
   */
  type?: SessionType;
  /** Legacy flat list — every id assigned the SPEAKER role. */
  speakerIds?: string[];
  /** Preferred: session-level roles. Takes precedence over `speakerIds`. */
  sessionRoles?: SessionSpeakerInput[];
  topics?: SessionTopicInput[];
}

export interface CreateSessionInput extends SessionFieldsInput {
  eventId: string;
  userId: string;
  source: "rest" | "mcp" | "api";
  requestIp?: string | null;
  name: string;
  startTime: Date;
  endTime: Date;
  /**
   * Batch callers (the agenda CSV import) set this so a 60-row import
   * doesn't fan out 60 "Session Created" notifications — the caller sends
   * ONE summary instead. Audit rows + stats refresh are NOT suppressed.
   */
  suppressAdminNotification?: boolean;
}

export interface UpdateSessionInput extends SessionFieldsInput {
  eventId: string;
  sessionId: string;
  userId: string;
  source: "rest" | "mcp" | "api";
  requestIp?: string | null;
  /** Optimistic-lock token. When supplied, a concurrent edit yields STALE_WRITE. */
  expectedUpdatedAt?: Date | null;
}

export type SessionServiceErrorCode =
  | "EVENT_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "INVALID_TIME_RANGE"
  | "OUTSIDE_EVENT_DATES"
  | "TRACK_NOT_FOUND"
  | "ABSTRACT_NOT_FOUND"
  | "ABSTRACT_ALREADY_ASSIGNED"
  | "SPEAKERS_NOT_FOUND"
  | "INVALID_CAPACITY"
  | "BREAK_ITEM_HAS_PROGRAM"
  | "WEBINAR_ANCHOR_SESSION"
  | "STALE_WRITE"
  | "UNKNOWN";

type SessionRow = Awaited<ReturnType<typeof loadSession>>;

export type CreateSessionResult =
  | { ok: true; session: NonNullable<SessionRow> }
  | { ok: false; code: SessionServiceErrorCode; message: string; meta?: Record<string, unknown> };

export type UpdateSessionResult = CreateSessionResult;

// ── Shared select (the shape both callers return) ────────────────────────────

export const SESSION_SELECT = {
  id: true,
  name: true,
  description: true,
  startTime: true,
  endTime: true,
  location: true,
  capacity: true,
  status: true,
  type: true,
  updatedAt: true,
  track: { select: { id: true, name: true, color: true } },
  abstract: { select: { id: true, title: true } },
  speakers: {
    select: {
      role: true,
      speaker: {
        select: { id: true, title: true, firstName: true, lastName: true, status: true },
      },
    },
  },
  topics: {
    select: {
      id: true,
      title: true,
      sortOrder: true,
      duration: true,
      abstract: { select: { id: true, title: true } },
      speakers: {
        select: {
          speaker: {
            select: { id: true, title: true, firstName: true, lastName: true, status: true },
          },
        },
      },
    },
    orderBy: { sortOrder: "asc" as const },
  },
};

function loadSession(sessionId: string) {
  return db.eventSession.findUnique({ where: { id: sessionId }, select: SESSION_SELECT });
}

// ── Validation (single source of truth for BOTH callers) ─────────────────────

function fail(
  code: SessionServiceErrorCode,
  message: string,
  meta?: Record<string, unknown>,
): { ok: false; code: SessionServiceErrorCode; message: string; meta?: Record<string, unknown> } {
  return { ok: false, code, message, ...(meta ? { meta } : {}) };
}

/**
 * `EventSession.abstractId` and `SessionTopic.abstractId` are both @unique.
 * The pre-check in `validate` gives the friendly error, but two concurrent
 * writes can both pass it — the loser's P2002 used to surface as an opaque
 * 500 (L3, program/agenda review). Map it to the same domain error instead.
 */
function isAbstractUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return fields.includes("abstractId");
}

/** Collect every speaker id referenced by the payload (session-level + per-topic). */
function collectSpeakerIds(input: SessionFieldsInput): Set<string> {
  const ids = new Set<string>();
  input.speakerIds?.forEach((id) => ids.add(id));
  input.sessionRoles?.forEach((r) => ids.add(r.speakerId));
  input.topics?.forEach((t) => t.speakerIds?.forEach((id) => ids.add(id)));
  return ids;
}

/** `sessionRoles` wins over the legacy flat `speakerIds` when both are present. */
function buildSessionSpeakerRows(
  input: SessionFieldsInput,
): { speakerId: string; role: SessionRole }[] {
  if (input.sessionRoles && input.sessionRoles.length > 0) {
    return input.sessionRoles.map((r) => ({ speakerId: r.speakerId, role: r.role }));
  }
  if (input.speakerIds && input.speakerIds.length > 0) {
    return input.speakerIds.map((speakerId) => ({ speakerId, role: "SPEAKER" as const }));
  }
  return [];
}

/**
 * Times, track, abstract, speakers, capacity — the rules that used to be
 * copied (and to disagree) across the four call sites.
 *
 * `effectiveStart`/`effectiveEnd` let the update path validate the RESULTING
 * window when only one endpoint is being changed.
 */
async function validate(
  eventId: string,
  input: SessionFieldsInput,
  effectiveStart: Date | undefined,
  effectiveEnd: Date | undefined,
  opts: {
    excludeSessionIdForAbstract?: string;
    /** Update path only: the session being updated (for the webinar-anchor guard). */
    sessionId?: string;
    /** Update path only: the stored row's state, so the break-item check
     *  validates the RESULTING session when the payload omits a field. */
    existing?: {
      type: SessionType;
      abstractId: string | null;
      hasSpeakers: boolean;
      hasTopics: boolean;
      hasZoomMeeting: boolean;
    };
  } = {},
): Promise<{ ok: true } | { ok: false; code: SessionServiceErrorCode; message: string; meta?: Record<string, unknown> }> {
  const event = await db.event.findUnique({
    where: { id: eventId },
    // `settings` carries the webinar anchor pointer the break-item guard reads.
    select: { startDate: true, endDate: true, timezone: true, settings: true },
  });
  if (!event) return fail("EVENT_NOT_FOUND", `Event ${eventId} not found`);

  // A break item (registration desk / coffee / lunch / networking) is a plain
  // agenda time block — it may never END UP with speakers, topics, or an
  // abstract. Checked against the resulting state: converting a real session
  // to a break item requires clearing its program in the same payload (the
  // dashboard form does this by submitting empty lists) — we deliberately
  // never auto-delete a roster on the caller's behalf.
  const effectiveType = input.type ?? opts.existing?.type ?? "SESSION";
  if (isBreakSessionType(effectiveType)) {
    const resultingSpeakers =
      input.sessionRoles !== undefined || input.speakerIds !== undefined
        ? buildSessionSpeakerRows(input).length > 0
        : (opts.existing?.hasSpeakers ?? false);
    const resultingTopics =
      input.topics !== undefined ? input.topics.length > 0 : (opts.existing?.hasTopics ?? false);
    const resultingAbstract =
      input.abstractId !== undefined ? !!input.abstractId : !!opts.existing?.abstractId;
    if (resultingSpeakers || resultingTopics || resultingAbstract) {
      return fail(
        "BREAK_ITEM_HAS_PROGRAM",
        "A break item (registration, coffee break, lunch, networking) cannot have speakers, topics, or an abstract. Remove them first, or save with empty speaker and topic lists.",
      );
    }

    // M2 (break-items review): an attached Zoom meeting is also program
    // content — and the edit dialog hides the Zoom section for break items,
    // so converting would leave a live, billable, joinable meeting with no UI
    // able to delete it.
    if (opts.existing?.hasZoomMeeting) {
      return fail(
        "BREAK_ITEM_HAS_PROGRAM",
        "This session has a Zoom meeting attached. Delete the Zoom meeting before converting it to a break item.",
      );
    }

    // M3: the webinar anchor session backs the join links already emailed to
    // every registrant — mirrors the DELETE route's anchor refusal.
    if (opts.sessionId && readWebinarSettings(event.settings)?.sessionId === opts.sessionId) {
      return fail(
        "WEBINAR_ANCHOR_SESSION",
        "This is the webinar's main session and can't be converted to a break item.",
      );
    }
  }

  if (effectiveStart && effectiveEnd) {
    // Zero-duration is invalid on EVERY path. MCP `update_session` used to
    // allow it (`newEnd < newStart`), producing an agenda entry that is only
    // ever "live" for a single instant.
    if (effectiveEnd <= effectiveStart) {
      return fail("INVALID_TIME_RANGE", "End time must be after start time");
    }
    const timezone = resolveTimezone(event.timezone);
    if (!isSessionWithinEventDates(effectiveStart, effectiveEnd, event.startDate, event.endDate, timezone)) {
      return fail(
        "OUTSIDE_EVENT_DATES",
        `Session must fall within event dates (${localDateInTz(event.startDate, timezone)} to ${localDateInTz(event.endDate, timezone)} ${timezone})`,
      );
    }
  }

  if (input.capacity != null && (!Number.isInteger(input.capacity) || input.capacity < 1)) {
    return fail("INVALID_CAPACITY", "Capacity must be a positive whole number");
  }

  if (input.trackId) {
    const track = await db.track.findFirst({
      where: { id: input.trackId, eventId },
      select: { id: true },
    });
    if (!track) return fail("TRACK_NOT_FOUND", `Track ${input.trackId} not found for this event`);
  }

  if (input.abstractId) {
    const abstract = await db.abstract.findFirst({
      where: { id: input.abstractId, eventId },
      select: { id: true },
    });
    if (!abstract) return fail("ABSTRACT_NOT_FOUND", `Abstract ${input.abstractId} not found for this event`);

    // `EventSession.abstractId` is @unique. The DB is the real guard (a race
    // still surfaces as P2002 → UNKNOWN), but check first for a friendly error.
    const taken = await db.eventSession.findFirst({
      where: {
        abstractId: input.abstractId,
        ...(opts.excludeSessionIdForAbstract && { id: { not: opts.excludeSessionIdForAbstract } }),
      },
      select: { id: true },
    });
    if (taken) {
      return fail("ABSTRACT_ALREADY_ASSIGNED", "Abstract is already assigned to another session", {
        sessionId: taken.id,
      });
    }
  }

  const speakerIds = collectSpeakerIds(input);
  if (speakerIds.size > 0) {
    const found = await db.speaker.findMany({
      where: { id: { in: [...speakerIds] }, eventId },
      select: { id: true },
    });
    if (found.length !== speakerIds.size) {
      const foundIds = new Set(found.map((s) => s.id));
      const missing = [...speakerIds].filter((id) => !foundIds.has(id));
      return fail("SPEAKERS_NOT_FOUND", `Speaker IDs not found in this event: ${missing.join(", ")}`, {
        missing,
      });
    }
  }

  return { ok: true };
}

// ── Create ───────────────────────────────────────────────────────────────────

export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
  const { eventId, userId, source, requestIp } = input;

  const valid = await validate(eventId, input, input.startTime, input.endTime);
  if (!valid.ok) {
    apiLogger.warn(
      { msg: "session-service:create-rejected", eventId, userId, source, code: valid.code },
      valid.message,
    );
    return valid;
  }

  let created: { id: string };
  try {
    created = await db.eventSession.create({
      data: {
        eventId,
        name: input.name,
        description: input.description ?? null,
        trackId: input.trackId ?? null,
        abstractId: input.abstractId ?? null,
        startTime: input.startTime,
        endTime: input.endTime,
        location: input.location ?? null,
        capacity: input.capacity ?? null,
        // MCP used to silently drop `status`; it now honours it (default
        // SCHEDULED, matching the REST Zod default).
        status: input.status ?? "SCHEDULED",
        type: input.type ?? "SESSION",
        speakers: (() => {
          const rows = buildSessionSpeakerRows(input);
          return rows.length > 0 ? { create: rows } : undefined;
        })(),
        topics:
          input.topics && input.topics.length > 0
            ? {
                create: input.topics.map((t, i) => ({
                  title: t.title,
                  abstractId: t.abstractId || null,
                  duration: t.duration || null,
                  // MCP used to drop client-supplied sortOrder.
                  sortOrder: t.sortOrder ?? i,
                  speakers:
                    t.speakerIds && t.speakerIds.length > 0
                      ? { create: t.speakerIds.map((speakerId) => ({ speakerId })) }
                      : undefined,
                })),
              }
            : undefined,
      },
      select: { id: true },
    });
  } catch (err) {
    if (isAbstractUniqueViolation(err)) {
      apiLogger.warn(
        { msg: "session-service:abstract-unique-race", eventId, userId, source },
        "Abstract was assigned to another session concurrently",
      );
      return fail("ABSTRACT_ALREADY_ASSIGNED", "Abstract is already assigned to another session");
    }
    apiLogger.error({ err, eventId, userId, source }, "session-service:create-failed");
    return fail("UNKNOWN", err instanceof Error ? err.message : "Failed to create session");
  }

  const session = await loadSession(created.id);
  if (!session) return fail("UNKNOWN", "Session vanished immediately after creation");

  apiLogger.info({ sessionId: session.id, eventId, userId, source }, "session:created");

  // ── Side effects owned by the service (were missing entirely on MCP) ──
  refreshEventStats(eventId);

  db.auditLog
    .create({
      data: {
        eventId,
        userId,
        action: "CREATE",
        entityType: "EventSession",
        entityId: session.id,
        changes: {
          ...JSON.parse(JSON.stringify({ session })),
          source,
          ...(requestIp ? { ip: requestIp } : {}),
        },
      },
    })
    .catch((err) => apiLogger.error({ err, eventId, sessionId: session.id }, "session-create:audit-log-failed"));

  if (!input.suppressAdminNotification) {
    notifyEventAdmins(eventId, {
      type: "REGISTRATION",
      title: "Session Created",
      message: `New session: "${session.name}"${source === "mcp" ? " (via the AI agent)" : ""}`,
      link: `/events/${eventId}/agenda`,
    }).catch((err) =>
      apiLogger.error({ err, eventId, sessionId: session.id }, "session-create:notify-failed"),
    );
  }

  return { ok: true, session };
}

// ── Update ───────────────────────────────────────────────────────────────────

/** Thrown inside the transaction to abort on a lost optimistic-lock claim. */
class StaleWriteSentinel extends Error {}

export async function updateSession(input: UpdateSessionInput): Promise<UpdateSessionResult> {
  const { eventId, sessionId, userId, source, requestIp, expectedUpdatedAt } = input;

  const existing = await db.eventSession.findFirst({
    where: { id: sessionId, eventId },
    select: {
      id: true,
      startTime: true,
      endTime: true,
      status: true,
      type: true,
      abstractId: true,
      zoomMeeting: { select: { id: true } },
      _count: { select: { speakers: true, topics: true } },
    },
  });
  if (!existing) {
    apiLogger.warn({ msg: "session-service:session-not-found", sessionId, eventId, userId, source });
    return fail("SESSION_NOT_FOUND", `Session ${sessionId} not found in this event`);
  }

  // Validate the RESULTING window when only one endpoint is supplied.
  const effectiveStart = input.startTime ?? existing.startTime;
  const effectiveEnd = input.endTime ?? existing.endTime;

  const valid = await validate(eventId, input, effectiveStart, effectiveEnd, {
    excludeSessionIdForAbstract: sessionId,
    sessionId,
    existing: {
      type: existing.type,
      abstractId: existing.abstractId,
      hasSpeakers: existing._count.speakers > 0,
      hasTopics: existing._count.topics > 0,
      hasZoomMeeting: existing.zoomMeeting != null,
    },
  });
  if (!valid.ok) {
    apiLogger.warn(
      { msg: "session-service:update-rejected", sessionId, eventId, userId, source, code: valid.code },
      valid.message,
    );
    return valid;
  }

  if (!expectedUpdatedAt) {
    apiLogger.warn({
      msg: "optimistic-lock:missing-expectedUpdatedAt",
      resource: "session",
      resourceId: sessionId,
      source,
    });
  }

  try {
    await db.$transaction(async (tx) => {
      // 1. CLAIM THE ROW FIRST (H1). Nothing below runs unless we own the write.
      const claim = await tx.eventSession.updateMany({
        where: {
          id: sessionId,
          ...(expectedUpdatedAt && { updatedAt: expectedUpdatedAt }),
        },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description || null }),
          ...(input.trackId !== undefined && { trackId: input.trackId }),
          ...(input.abstractId !== undefined && { abstractId: input.abstractId }),
          ...(input.startTime !== undefined && { startTime: input.startTime }),
          ...(input.endTime !== undefined && { endTime: input.endTime }),
          ...(input.location !== undefined && { location: input.location || null }),
          ...(input.capacity !== undefined && { capacity: input.capacity }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.type !== undefined && { type: input.type }),
          updatedAt: new Date(),
        },
      });
      if (claim.count === 0) throw new StaleWriteSentinel();

      // 2. Session-level speakers — atomic swap, never an in-between state.
      if (input.sessionRoles !== undefined || input.speakerIds !== undefined) {
        await tx.sessionSpeaker.deleteMany({ where: { sessionId } });
        const rows = buildSessionSpeakerRows(input);
        if (rows.length > 0) {
          await tx.sessionSpeaker.createMany({
            data: rows.map((r) => ({ sessionId, ...r })),
          });
        }

        // L1 (program/agenda review): a speaker dropped from the session must
        // also drop off this session's TOPICS, or they keep appearing on the
        // public agenda under the topic. When the payload replaces topics too,
        // step 3 writes the exact requested per-topic rosters instead.
        if (input.topics === undefined) {
          await tx.topicSpeaker.deleteMany({
            where: {
              topic: { sessionId },
              speakerId: { notIn: rows.map((r) => r.speakerId) },
            },
          });
        }
      }

      // 3. Topics. Payload rows carrying an id that belongs to this session
      //    are UPDATED in place (stable topic ids — M2); rows without one (or
      //    with a foreign id, which is ignored) are created; existing topics
      //    absent from the payload are deleted (cascades to TopicSpeaker).
      //    A mid-loop failure rolls the whole replace back.
      if (input.topics !== undefined) {
        const existingTopics = await tx.sessionTopic.findMany({
          where: { sessionId },
          select: { id: true },
        });
        const existingIds = new Set(existingTopics.map((t) => t.id));
        // Each existing id is consumed at most once — a duplicated id in the
        // payload updates the row on first use and creates a topic after.
        const availableIds = new Set(existingIds);
        const keptIds: string[] = [];
        const plan = input.topics.map((t) => {
          const keep = t.id && availableIds.has(t.id) ? t.id : null;
          if (keep) {
            availableIds.delete(keep);
            keptIds.push(keep);
          }
          return { topic: t, existingId: keep };
        });

        await tx.sessionTopic.deleteMany({
          where: { sessionId, id: { notIn: keptIds } },
        });

        for (let i = 0; i < plan.length; i++) {
          const { topic: t, existingId } = plan[i];
          const fields = {
            title: t.title,
            abstractId: t.abstractId || null,
            duration: t.duration || null,
            sortOrder: t.sortOrder ?? i,
          };
          if (existingId) {
            await tx.sessionTopic.update({ where: { id: existingId }, data: fields });
            await tx.topicSpeaker.deleteMany({ where: { topicId: existingId } });
            if (t.speakerIds && t.speakerIds.length > 0) {
              await tx.topicSpeaker.createMany({
                data: t.speakerIds.map((speakerId) => ({ topicId: existingId, speakerId })),
              });
            }
          } else {
            await tx.sessionTopic.create({
              data: {
                sessionId,
                ...fields,
                speakers:
                  t.speakerIds && t.speakerIds.length > 0
                    ? { create: t.speakerIds.map((speakerId) => ({ speakerId })) }
                    : undefined,
              },
            });
          }
        }
      }
    });
  } catch (err) {
    if (err instanceof StaleWriteSentinel) {
      apiLogger.info({ msg: "session:stale-write-rejected", sessionId, eventId, userId, source });
      return fail(
        "STALE_WRITE",
        "This session was modified by someone else after you opened it. Reload the latest version and try again.",
      );
    }
    if (isAbstractUniqueViolation(err)) {
      apiLogger.warn(
        { msg: "session-service:abstract-unique-race", sessionId, eventId, userId, source },
        "Abstract was assigned to another session concurrently",
      );
      return fail("ABSTRACT_ALREADY_ASSIGNED", "Abstract is already assigned to another session");
    }
    apiLogger.error({ err, sessionId, eventId, userId, source }, "session-service:update-failed");
    return fail("UNKNOWN", err instanceof Error ? err.message : "Failed to update session");
  }

  const session = await loadSession(sessionId);
  if (!session) return fail("SESSION_NOT_FOUND", `Session ${sessionId} not found after update`);

  apiLogger.info({ sessionId, eventId, userId, source }, "session:updated");

  refreshEventStats(eventId);

  db.auditLog
    .create({
      data: {
        eventId,
        userId,
        action: "UPDATE",
        entityType: "EventSession",
        entityId: sessionId,
        changes: {
          before: { status: existing.status },
          after: { status: session.status },
          source,
          fieldsChanged: Object.keys(input).filter(
            (k) => !["eventId", "sessionId", "userId", "source", "requestIp", "expectedUpdatedAt"].includes(k),
          ),
          ...(requestIp ? { ip: requestIp } : {}),
        },
      },
    })
    .catch((err) => apiLogger.error({ err, eventId, sessionId }, "session-update:audit-log-failed"));

  return { ok: true, session };
}
