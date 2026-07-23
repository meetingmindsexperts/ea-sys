import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { ToolExecutor } from "./_shared";
import {
  SessionRole as PrismaSessionRole,
  SessionStatus as PrismaSessionStatus,
  SessionType as PrismaSessionType,
  type SessionType,
} from "@prisma/client";
import {
  addSessionSpeaker as addSessionSpeakerService,
  createSession as createSessionService,
  removeSessionSpeaker as removeSessionSpeakerService,
  replaceSessionRoster as replaceSessionRosterService,
  updateSession as updateSessionService,
  type SessionRole,
  type SessionStatus,
} from "@/services/session-service";
import { BREAK_SESSION_TYPES, isBreakSessionType } from "@/lib/session-enums";

// Derived from the Prisma enums so a new value can't silently drift out of
// the agent's whitelists (the session-enums.ts pattern).
const VALID_SESSION_ROLES = new Set<string>(Object.values(PrismaSessionRole));
const VALID_SESSION_STATUSES = new Set<string>(Object.values(PrismaSessionStatus));
const VALID_SESSION_TYPES = new Set<string>(Object.values(PrismaSessionType));

/** Agent input is untyped JSON — coerce to the service's unions, defaulting
 *  the same way the pre-service executor did (unknown role → SPEAKER). */
function normalizeRole(role: unknown): SessionRole {
  const r = String(role ?? "").toUpperCase();
  return (VALID_SESSION_ROLES.has(r) ? r : "SPEAKER") as SessionRole;
}
function normalizeStatus(status: unknown): SessionStatus {
  const s = String(status ?? "").toUpperCase();
  return (VALID_SESSION_STATUSES.has(s) ? s : "SCHEDULED") as SessionStatus;
}
/** Unlike role/status, an unrecognized type is a hard error — silently
 *  defaulting a typo'd "COFFEE" to SESSION (or vice versa) would flip how the
 *  agenda renders the item and which form sections apply. */
function parseSessionType(type: unknown): SessionType | { error: string; code: string } {
  const t = String(type ?? "").toUpperCase();
  if (!VALID_SESSION_TYPES.has(t)) {
    return {
      error: `Invalid type "${String(type)}". Must be one of: ${[...VALID_SESSION_TYPES].join(", ")}`,
      code: "INVALID_TYPE",
    };
  }
  return t as SessionType;
}

const listSessions: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 100);
    const sessions = await db.eventSession.findMany({
      where: {
        eventId: ctx.eventId,
        ...(input.trackId ? { trackId: String(input.trackId) } : {}),
      },
      select: {
        id: true,
        name: true,
        startTime: true,
        endTime: true,
        location: true,
        status: true,
        type: true,
        track: { select: { name: true, color: true } },
        // Session-level roles. speaker.id lets n8n cross-link to the speaker
        // record; speaker.title carries the honorific for agenda display.
        speakers: {
          select: {
            role: true,
            speaker: { select: { id: true, title: true, firstName: true, lastName: true } },
          },
        },
        // Agenda items within the session, each with its own per-topic
        // speakers (TopicSpeaker has no role of its own — just the link).
        topics: {
          select: {
            id: true,
            title: true,
            duration: true,
            sortOrder: true,
            speakers: {
              select: {
                speaker: { select: { id: true, title: true, firstName: true, lastName: true } },
              },
            },
          },
          orderBy: { sortOrder: "asc" },
        },
      },
      orderBy: { startTime: "asc" },
      take: limit,
    });
    return { sessions, total: sessions.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_sessions failed");
    return { error: "Failed to fetch sessions" };
  }
};

const createSession: ToolExecutor = async (input, ctx) => {
  try {
    const name = String(input.name ?? "").trim();
    if (!name) return { error: "Session name is required", code: "MISSING_NAME" };

    const startTime = new Date(String(input.startTime));
    const endTime = new Date(String(input.endTime));
    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      return {
        error: "startTime and endTime must be valid ISO 8601 datetime strings",
        code: "INVALID_DATETIME",
      };
    }

    const rawSpeakerIds = Array.isArray(input.speakerIds)
      ? (input.speakerIds as string[]).slice(0, 50)
      : undefined;
    const rawRoles = Array.isArray(input.sessionRoles)
      ? (input.sessionRoles as { speakerId: string; role: string }[]).slice(0, 50)
      : undefined;
    const rawTopics = Array.isArray(input.topics)
      ? (input.topics as { title: string; duration?: number; abstractId?: string; sortOrder?: number; speakerIds?: string[] }[]).slice(0, 50)
      : undefined;

    let sessionType: SessionType | undefined;
    if (input.type != null) {
      const parsed = parseSessionType(input.type);
      if (typeof parsed !== "string") return parsed;
      sessionType = parsed;
    }

    // Validation, the write, the audit row, the admin notification and the
    // stats refresh all live in the service (review H4) — this executor used to
    // write NO audit row and send NO notification, and silently dropped
    // `status`, `abstractId` and topic `sortOrder`.
    const result = await createSessionService({
      eventId: ctx.eventId,
      userId: ctx.userId,
      source: "mcp",
      name,
      startTime,
      endTime,
      ...(sessionType && { type: sessionType }),
      ...(input.description != null && { description: String(input.description) }),
      ...(input.trackId != null && { trackId: String(input.trackId) }),
      ...(input.abstractId != null && { abstractId: String(input.abstractId) }),
      ...(input.location != null && { location: String(input.location) }),
      ...(input.capacity != null && { capacity: Number(input.capacity) }),
      ...(input.status != null && { status: normalizeStatus(input.status) }),
      ...(rawSpeakerIds && { speakerIds: rawSpeakerIds }),
      ...(rawRoles && { sessionRoles: rawRoles.map((r) => ({ speakerId: r.speakerId, role: normalizeRole(r.role) })) }),
      ...(rawTopics && {
        topics: rawTopics.map((t) => ({
          title: t.title,
          abstractId: t.abstractId ?? null,
          duration: t.duration ?? null,
          ...(t.sortOrder != null && { sortOrder: t.sortOrder }),
          speakerIds: t.speakerIds,
        })),
      }),
    });

    if (!result.ok) return { error: result.message, code: result.code, ...(result.meta ?? {}) };
    return { success: true, session: result.session };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_session failed");
    return { error: err instanceof Error ? err.message : "Failed to create session" };
  }
};

const addTopicToSession: ToolExecutor = async (input, ctx) => {
  try {
    const sessionId = String(input.sessionId ?? "").trim();
    const title = String(input.title ?? "").trim();
    if (!sessionId) return { error: "sessionId is required" };
    if (!title) return { error: "Topic title is required" };

    // Verify session belongs to this event
    const session = await db.eventSession.findFirst({
      where: { id: sessionId, eventId: ctx.eventId },
      select: { id: true, name: true, type: true },
    });
    if (!session) return { error: `Session ${sessionId} not found in this event` };
    // H1 (break-items review): this executor bypasses the session service, so
    // it must enforce the break-item invariant itself.
    if (isBreakSessionType(session.type)) {
      return {
        error:
          "This is a break item (registration/coffee/lunch/networking) — it cannot have topics. Convert it to a program type (SESSION/WORKSHOP/SYMPOSIUM) first via update_session.",
        code: "BREAK_ITEM_HAS_PROGRAM",
      };
    }

    const rawSpeakerIds = Array.isArray(input.speakerIds)
      ? (input.speakerIds as string[]).slice(0, 20)
      : [];

    // Validate speakers
    if (rawSpeakerIds.length > 0) {
      const valid = await db.speaker.findMany({
        where: { id: { in: rawSpeakerIds }, eventId: ctx.eventId },
        select: { id: true },
      });
      const validIds = new Set(valid.map((s) => s.id));
      const invalid = rawSpeakerIds.filter((id) => !validIds.has(id));
      if (invalid.length > 0) {
        return { error: `Speaker IDs not found: ${invalid.join(", ")}` };
      }
    }

    // Append-at-end sortOrder is computed INSIDE the same transaction as the
    // create so two concurrent add_topic calls (MCP/n8n) can't read the same
    // count and tie (M10, program/agenda review — same shape as the
    // certificate templates fix). max+1 instead of count() so a payload that
    // supplied explicit sortOrders earlier still appends after them.
    const topic = await db.$transaction(async (tx) => {
      const maxOrder = await tx.sessionTopic.aggregate({
        where: { sessionId },
        _max: { sortOrder: true },
      });
      return tx.sessionTopic.create({
        data: {
          sessionId,
          title,
          duration: input.duration ? Number(input.duration) : null,
          sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
          speakers: rawSpeakerIds.length > 0
            ? { create: rawSpeakerIds.map((sid) => ({ speakerId: sid })) }
            : undefined,
        },
        select: {
          id: true,
          title: true,
          duration: true,
          speakers: { select: { speaker: { select: { firstName: true, lastName: true } } } },
        },
      });
    });

    return {
      success: true,
      topic: {
        ...topic,
        speakers: topic.speakers.map((ts) => `${ts.speaker.firstName} ${ts.speaker.lastName}`),
      },
      session: session.name,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:add_topic_to_session failed");
    return { error: "Failed to add topic to session" };
  }
};

const listLiveSessionsNow: ToolExecutor = async (input, ctx) => {
  try {
    const withinMinutes = input.withinMinutes != null ? Math.max(0, Number(input.withinMinutes)) : 0;
    const now = new Date();
    const windowEnd = new Date(now.getTime() + withinMinutes * 60 * 1000);

    const sessions = await db.eventSession.findMany({
      where: {
        eventId: ctx.eventId,
        status: { not: "CANCELLED" },
        // Break items (registration/coffee/lunch/networking) are agenda time
        // blocks, not joinable program sessions — exclude them here.
        // Workshops/symposia ARE joinable program sessions.
        type: { notIn: BREAK_SESSION_TYPES },
        // Currently live OR starting within the lookahead window
        OR: [
          { startTime: { lte: now }, endTime: { gte: now } },
          ...(withinMinutes > 0 ? [{ startTime: { gt: now, lte: windowEnd } }] : []),
        ],
      },
      select: {
        id: true,
        name: true,
        startTime: true,
        endTime: true,
        location: true,
        status: true,
        track: { select: { name: true, color: true } },
        speakers: {
          select: {
            role: true,
            speaker: { select: { title: true, firstName: true, lastName: true } },
          },
        },
        zoomMeeting: {
          select: { joinUrl: true, passcode: true, meetingType: true },
        },
      },
      orderBy: { startTime: "asc" },
    });

    const enriched = sessions.map((s) => ({
      ...s,
      isLiveNow: s.startTime <= now && s.endTime >= now,
      minutesUntilStart: s.startTime > now
        ? Math.round((s.startTime.getTime() - now.getTime()) / (60 * 1000))
        : 0,
    }));

    return { now: now.toISOString(), sessions: enriched, total: sessions.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_live_sessions_now failed");
    return { error: "Failed to list live sessions" };
  }
};

const updateSession: ToolExecutor = async (input, ctx) => {
  try {
    const sessionId = String(input.sessionId ?? "").trim();
    if (!sessionId) return { error: "sessionId is required", code: "MISSING_SESSION_ID" };

    const parseDate = (v: unknown, field: string) => {
      const d = new Date(String(v));
      if (isNaN(d.getTime())) throw new Error(`${field} must be a valid ISO 8601 datetime string`);
      return d;
    };

    const rawSpeakerIds = Array.isArray(input.speakerIds)
      ? (input.speakerIds as string[]).slice(0, 50)
      : undefined;
    const rawRoles = Array.isArray(input.sessionRoles)
      ? (input.sessionRoles as { speakerId: string; role: string }[]).slice(0, 50)
      : undefined;
    const rawTopics = Array.isArray(input.topics)
      ? (input.topics as { id?: string; title: string; duration?: number; abstractId?: string; sortOrder?: number; speakerIds?: string[] }[]).slice(0, 50)
      : undefined;

    let sessionType: SessionType | undefined;
    if (input.type != null) {
      const parsed = parseSessionType(input.type);
      if (typeof parsed !== "string") return parsed;
      sessionType = parsed;
    }

    // Delegates to the shared service (review H4/H1): the lock-first atomic
    // transaction, the event-timezone date validation, the `endTime <= startTime`
    // rule (this path used to allow a zero-duration session) and the positive
    // capacity rule (this path used to allow 0) are now identical to REST.
    const result = await updateSessionService({
      eventId: ctx.eventId,
      sessionId,
      userId: ctx.userId,
      source: "mcp",
      ...(sessionType && { type: sessionType }),
      ...(input.name != null && { name: String(input.name).trim() }),
      ...(input.description !== undefined && { description: input.description == null ? null : String(input.description) }),
      ...(input.trackId !== undefined && { trackId: input.trackId == null ? null : String(input.trackId) }),
      ...(input.abstractId !== undefined && { abstractId: input.abstractId == null ? null : String(input.abstractId) }),
      ...(input.startTime != null && { startTime: parseDate(input.startTime, "startTime") }),
      ...(input.endTime != null && { endTime: parseDate(input.endTime, "endTime") }),
      ...(input.location !== undefined && { location: input.location == null ? null : String(input.location) }),
      ...(input.capacity !== undefined && { capacity: input.capacity == null ? null : Number(input.capacity) }),
      ...(input.status != null && { status: normalizeStatus(input.status) }),
      ...(rawSpeakerIds && { speakerIds: rawSpeakerIds }),
      ...(rawRoles && { sessionRoles: rawRoles.map((r) => ({ speakerId: r.speakerId, role: normalizeRole(r.role) })) }),
      ...(rawTopics && {
        topics: rawTopics.map((t) => ({
          // Existing topic ids are preserved (updated in place) — see M2 in
          // the session service.
          ...(t.id != null && { id: String(t.id) }),
          title: t.title,
          abstractId: t.abstractId ?? null,
          duration: t.duration ?? null,
          ...(t.sortOrder != null && { sortOrder: t.sortOrder }),
          speakerIds: t.speakerIds,
        })),
      }),
      expectedUpdatedAt: input.expectedUpdatedAt != null ? parseDate(input.expectedUpdatedAt, "expectedUpdatedAt") : null,
    });

    if (!result.ok) return { error: result.message, code: result.code, ...(result.meta ?? {}) };
    return { success: true, session: result.session };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_session failed");
    return { error: err instanceof Error ? err.message : "Failed to update session" };
  }
};

export const SESSION_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_sessions",
    description:
      "List scheduled sessions for this event. Optionally filter by trackId.",
    input_schema: {
      type: "object" as const,
      properties: {
        trackId: { type: "string", description: "Filter by track ID" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
      required: [],
    },
  },
  {
    name: "create_session",
    description:
      "Create a new session or agenda break item. Requires name, startTime, and endTime (ISO 8601 datetime strings). Optionally assign to a trackId, location, description, speakerIds, sessionRoles (with role per speaker), and topics (with per-topic speakers). Set type to WORKSHOP or SYMPOSIUM for those program formats (they carry speakers/topics/track exactly like SESSION), or to REGISTRATION/BREAK/LUNCH/NETWORKING for a break item — a plain agenda time block that cannot carry speakers, topics, or a track.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Session name" },
        type: {
          type: "string",
          enum: ["SESSION", "REGISTRATION", "BREAK", "LUNCH", "NETWORKING"],
          description:
            "Defaults to SESSION. Any other value creates a break item (no speakers/topics allowed).",
        },
        startTime: {
          type: "string",
          description: "ISO 8601 datetime, e.g. 2026-05-15T09:00:00",
        },
        endTime: {
          type: "string",
          description: "ISO 8601 datetime, e.g. 2026-05-15T10:00:00",
        },
        trackId: { type: "string", description: "Track ID to assign the session to" },
        location: { type: "string", description: "Room or venue location" },
        capacity: { type: "number", description: "Max attendees for this session" },
        description: { type: "string" },
        speakerIds: {
          type: "array",
          items: { type: "string" },
          description: "Speaker IDs to assign as SPEAKER role (legacy, use sessionRoles for explicit roles)",
        },
        sessionRoles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              speakerId: { type: "string" },
              role: { type: "string", enum: ["SPEAKER", "MODERATOR", "CHAIRPERSON", "PANELIST"] },
            },
            required: ["speakerId", "role"],
          },
          description: "Session-level speaker roles (e.g. moderator, chairperson)",
        },
        topics: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Topic title" },
              duration: { type: "number", description: "Duration in minutes" },
              abstractId: { type: "string", description: "Optional abstract ID to link this topic to" },
              speakerIds: { type: "array", items: { type: "string" }, description: "Speaker IDs for this topic" },
            },
            required: ["title"],
          },
          description: "Topics within the session, each with optional speakers",
        },
      },
      required: ["name", "startTime", "endTime"],
    },
  },
  {
    name: "add_topic_to_session",
    description:
      "Add a topic to an existing session. Topics represent individual talks or agenda items within a session. Each topic can have its own speakers.",
    input_schema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to add the topic to" },
        title: { type: "string", description: "Topic title" },
        duration: { type: "number", description: "Duration in minutes" },
        speakerIds: {
          type: "array",
          items: { type: "string" },
          description: "Speaker IDs to assign to this topic",
        },
      },
      required: ["sessionId", "title"],
    },
  },
  {
    name: "update_session",
    description:
      "Update a session's metadata (name, description, startTime, endTime, location, capacity, trackId, status, type). Validates startTime/endTime fall within the event's date range. Does NOT touch topics or speakers — use add_topic_to_session / add_speaker_to_session / replace_session_speakers for those. WORKSHOP/SYMPOSIUM are program types (same rules as SESSION); converting type to a break item (REGISTRATION/BREAK/LUNCH/NETWORKING) is rejected with BREAK_ITEM_HAS_PROGRAM while the session still has speakers or topics — remove them first.",
    input_schema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to update" },
        name: { type: "string" },
        type: {
          type: "string",
          enum: ["SESSION", "REGISTRATION", "BREAK", "LUNCH", "NETWORKING"],
          description: "SESSION or a break item (plain agenda time block, no speakers/topics).",
        },
        description: { type: "string" },
        startTime: { type: "string", description: "ISO 8601 datetime" },
        endTime: { type: "string", description: "ISO 8601 datetime" },
        location: { type: "string" },
        capacity: { type: "number" },
        trackId: { type: "string", description: "Track ID, or null to unassign" },
        status: { type: "string", enum: ["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"] },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "add_speaker_to_session",
    description:
      "Assign a speaker to a session with a role. Idempotent: same role is a no-op; a different role updates the existing assignment. Use for day-of speaker swaps.",
    input_schema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        speakerId: { type: "string" },
        role: { type: "string", enum: ["SPEAKER", "MODERATOR", "CHAIRPERSON", "PANELIST"], description: "Defaults to SPEAKER" },
      },
      required: ["sessionId", "speakerId"],
    },
  },
  {
    name: "remove_speaker_from_session",
    description:
      "Remove a speaker from a session. Idempotent — returns alreadyRemoved=true when the speaker wasn't assigned.",
    input_schema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        speakerId: { type: "string" },
      },
      required: ["sessionId", "speakerId"],
    },
  },
  {
    name: "replace_session_speakers",
    description:
      "Replace ALL speakers on a session in one atomic operation. Pass the new full speaker list; assignments=[] clears all. Max 100 assignments.",
    input_schema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        assignments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              speakerId: { type: "string" },
              role: { type: "string", enum: ["SPEAKER", "MODERATOR", "CHAIRPERSON", "PANELIST"], description: "Defaults to SPEAKER" },
            },
            required: ["speakerId"],
          },
          description: "Full replacement speaker list with per-speaker roles",
        },
      },
      required: ["sessionId", "assignments"],
    },
  },
  {
    name: "list_live_sessions_now",
    description:
      "List sessions currently live (now between startTime and endTime). Optional withinMinutes extends the window to sessions starting within N minutes.",
    input_schema: {
      type: "object" as const,
      properties: {
        withinMinutes: { type: "number", description: "Also include sessions starting within this many minutes" },
      },
      required: [],
    },
  },
];

// ─── W2-F3 fix: session speaker management via MCP ────────────────────────
//
// Wave-2 confirmed update_session can't change speakers — operators had
// to delete-and-recreate (loses session id + topics + delegate picks)
// or use the dashboard UI for day-of speaker swaps. Below: idempotent
// add / remove / replace tools matching the SessionSpeaker join-table.
//
// All three tools verify the session is in the caller's event (org-scope)
// and that any provided speakers belong to that same event.

const SESSION_ROLES = VALID_SESSION_ROLES;

// Thin MCP wrappers — the roster domain logic (H1 break-item gate, idempotent
// upsert, transactional remove + L1 topic cleanup, the atomic replace-all swap,
// audits) lives in session-service (addSessionSpeaker / removeSessionSpeaker /
// replaceSessionRoster — duplication-audit findings 4+7). These boundaries
// keep loose-input parsing + the MCP response shapes.

const addSpeakerToSession: ToolExecutor = async (input, ctx) => {
  try {
    const sessionId = String(input.sessionId ?? "").trim();
    const speakerId = String(input.speakerId ?? "").trim();
    const rawRole = input.role ? String(input.role).toUpperCase() : "SPEAKER";
    if (!sessionId) return { error: "sessionId is required", code: "MISSING_SESSION_ID" };
    if (!speakerId) return { error: "speakerId is required", code: "MISSING_SPEAKER_ID" };
    if (!SESSION_ROLES.has(rawRole)) {
      return { error: `Invalid role. Must be one of: ${[...SESSION_ROLES].join(", ")}`, code: "INVALID_ROLE" };
    }

    const result = await addSessionSpeakerService({
      eventId: ctx.eventId,
      sessionId,
      speakerId,
      role: rawRole as SessionRole,
      actorUserId: ctx.userId,
      source: "mcp",
    });
    if (!result.ok) {
      return result.code === "UNKNOWN"
        ? { error: result.message }
        : { error: result.message, code: result.code };
    }
    if (result.alreadyAssigned) {
      return { sessionSpeaker: result.sessionSpeaker, alreadyAssigned: true };
    }
    return { sessionSpeaker: result.sessionSpeaker, alreadyAssigned: false, roleChanged: result.roleChanged };
  } catch (err) {
    apiLogger.error({ err }, "agent:add_speaker_to_session failed");
    return { error: err instanceof Error ? err.message : "Failed to add speaker to session" };
  }
};

const removeSpeakerFromSession: ToolExecutor = async (input, ctx) => {
  try {
    const sessionId = String(input.sessionId ?? "").trim();
    const speakerId = String(input.speakerId ?? "").trim();
    if (!sessionId) return { error: "sessionId is required", code: "MISSING_SESSION_ID" };
    if (!speakerId) return { error: "speakerId is required", code: "MISSING_SPEAKER_ID" };

    const result = await removeSessionSpeakerService({
      eventId: ctx.eventId,
      sessionId,
      speakerId,
      actorUserId: ctx.userId,
      source: "mcp",
    });
    if (!result.ok) {
      return result.code === "UNKNOWN"
        ? { error: result.message }
        : { error: result.message, code: result.code };
    }
    if (!result.removed) {
      return { success: false, message: "Speaker was not assigned to this session", alreadyRemoved: true };
    }
    return { success: true, sessionId, speakerId, topicAssignmentsRemoved: result.topicRowsRemoved };
  } catch (err) {
    apiLogger.error({ err }, "agent:remove_speaker_from_session failed");
    return { error: err instanceof Error ? err.message : "Failed to remove speaker from session" };
  }
};

const replaceSessionSpeakers: ToolExecutor = async (input, ctx) => {
  try {
    const sessionId = String(input.sessionId ?? "").trim();
    if (!sessionId) return { error: "sessionId is required", code: "MISSING_SESSION_ID" };

    const rawAssignments = Array.isArray(input.assignments) ? input.assignments : null;
    if (!rawAssignments) {
      return { error: "assignments must be an array of {speakerId, role?} objects", code: "MISSING_ASSIGNMENTS" };
    }
    if (rawAssignments.length > 100) {
      return { error: "Too many assignments (max 100)", code: "TOO_MANY_ASSIGNMENTS" };
    }

    // Normalise + validate each assignment up front so we don't
    // half-apply on bad input.
    const normalised: { speakerId: string; role: SessionRole }[] = [];
    for (let i = 0; i < rawAssignments.length; i++) {
      const a = rawAssignments[i] as Record<string, unknown> | null;
      if (!a || typeof a !== "object") {
        return { error: `Assignment ${i}: must be an object`, code: "INVALID_ASSIGNMENT" };
      }
      const speakerId = a.speakerId ? String(a.speakerId).trim() : "";
      const role = a.role ? String(a.role).toUpperCase() : "SPEAKER";
      if (!speakerId) return { error: `Assignment ${i}: speakerId required`, code: "INVALID_ASSIGNMENT" };
      if (!SESSION_ROLES.has(role)) {
        return { error: `Assignment ${i}: invalid role "${role}"`, code: "INVALID_ROLE" };
      }
      normalised.push({ speakerId, role: role as SessionRole });
    }

    const result = await replaceSessionRosterService({
      eventId: ctx.eventId,
      sessionId,
      assignments: normalised,
      actorUserId: ctx.userId,
      source: "mcp",
    });
    if (!result.ok) {
      if (result.code === "SPEAKER_NOT_FOUND") {
        return { error: result.message, code: result.code, ...(result.meta ?? {}) };
      }
      return result.code === "UNKNOWN"
        ? { error: result.message }
        : { error: result.message, code: result.code };
    }

    return {
      sessionId,
      assignments: result.after,
      previousAssignmentCount: result.before.length,
      topicAssignmentsRemoved: result.topicRowsRemoved,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:replace_session_speakers failed");
    return { error: err instanceof Error ? err.message : "Failed to replace session speakers" };
  }
};

export const SESSION_EXECUTORS: Record<string, ToolExecutor> = {
  list_sessions: listSessions,
  create_session: createSession,
  update_session: updateSession,
  add_topic_to_session: addTopicToSession,
  add_speaker_to_session: addSpeakerToSession,
  remove_speaker_from_session: removeSpeakerFromSession,
  replace_session_speakers: replaceSessionSpeakers,
  list_live_sessions_now: listLiveSessionsNow,
};
