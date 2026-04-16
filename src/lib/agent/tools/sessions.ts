import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { ToolExecutor } from "./_shared";

const SESSION_STATUSES = new Set(["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"]);

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
        track: { select: { name: true, color: true } },
        speakers: {
          select: {
            role: true,
            speaker: { select: { firstName: true, lastName: true } },
          },
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
    if (!name) return { error: "Session name is required" };

    const startTime = new Date(String(input.startTime));
    const endTime = new Date(String(input.endTime));
    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      return { error: "startTime and endTime must be valid ISO 8601 datetime strings" };
    }
    if (endTime <= startTime) {
      return { error: "endTime must be after startTime" };
    }

    // Validate session falls within parent event's date range.
    // Compare as LOCAL DATES in the event's timezone (default Asia/Dubai),
    // not UTC timestamps — otherwise a session at 11pm Dubai on the last day
    // of the event would be rejected because its UTC timestamp is already
    // past midnight of day N+1.
    const event = await db.event.findFirst({
      where: { id: ctx.eventId },
      select: { startDate: true, endDate: true, timezone: true },
    });
    if (!event) return { error: "Event not found" };
    const timezone = event.timezone || "Asia/Dubai";
    const toLocalDate = (d: Date): string =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);
    const eventStartDate = toLocalDate(event.startDate);
    const eventEndDate = toLocalDate(event.endDate);
    const sessionStartDate = toLocalDate(startTime);
    const sessionEndDate = toLocalDate(endTime);
    if (sessionStartDate < eventStartDate || sessionEndDate > eventEndDate) {
      return {
        error: `Session must fall within event dates (${eventStartDate} to ${eventEndDate} ${timezone})`,
      };
    }

    // Validate trackId belongs to this event if provided
    if (input.trackId) {
      const track = await db.track.findFirst({
        where: { id: String(input.trackId), eventId: ctx.eventId },
        select: { id: true },
      });
      if (!track) return { error: `Track with ID ${input.trackId} not found for this event` };
    }

    // Collect all speaker IDs from all sources for validation
    const allSpeakerIds = new Set<string>();

    const rawSpeakerIds = Array.isArray(input.speakerIds)
      ? (input.speakerIds as string[]).slice(0, 50)
      : [];
    rawSpeakerIds.forEach((id) => allSpeakerIds.add(id));

    const sessionRoles = Array.isArray(input.sessionRoles)
      ? (input.sessionRoles as { speakerId: string; role: string }[]).slice(0, 50)
      : [];
    sessionRoles.forEach((r) => allSpeakerIds.add(r.speakerId));

    const topics = Array.isArray(input.topics)
      ? (input.topics as { title: string; duration?: number; speakerIds?: string[] }[]).slice(0, 50)
      : [];
    topics.forEach((t) => t.speakerIds?.forEach((id) => allSpeakerIds.add(id)));

    // Validate all speaker IDs belong to this event
    if (allSpeakerIds.size > 0) {
      const validSpeakers = await db.speaker.findMany({
        where: { id: { in: [...allSpeakerIds] }, eventId: ctx.eventId },
        select: { id: true },
      });
      const validIds = new Set(validSpeakers.map((s) => s.id));
      const invalid = [...allSpeakerIds].filter((id) => !validIds.has(id));
      if (invalid.length > 0) {
        return { error: `Speaker IDs not found in this event: ${invalid.join(", ")}` };
      }
    }

    // Build session speaker data (sessionRoles take precedence over flat speakerIds)
    const VALID_ROLES = new Set(["SPEAKER", "MODERATOR", "CHAIRPERSON", "PANELIST"]);
    const sessionSpeakerData = sessionRoles.length > 0
      ? sessionRoles.map((r) => ({
          speakerId: r.speakerId,
          role: (VALID_ROLES.has(r.role) ? r.role : "SPEAKER") as "SPEAKER" | "MODERATOR" | "CHAIRPERSON" | "PANELIST",
        }))
      : rawSpeakerIds.map((sid) => ({ speakerId: sid, role: "SPEAKER" as const }));

    const session = await db.eventSession.create({
      data: {
        eventId: ctx.eventId,
        name,
        startTime,
        endTime,
        trackId: input.trackId ? String(input.trackId) : null,
        location: input.location ? String(input.location) : null,
        description: input.description ? String(input.description) : null,
        speakers: sessionSpeakerData.length > 0
          ? { create: sessionSpeakerData }
          : undefined,
        topics: topics.length > 0
          ? {
              create: topics.map((t, i) => ({
                title: t.title,
                duration: t.duration || null,
                sortOrder: i,
                speakers: t.speakerIds?.length
                  ? { create: t.speakerIds.map((sid) => ({ speakerId: sid })) }
                  : undefined,
              })),
            }
          : undefined,
      },
      select: {
        id: true,
        name: true,
        startTime: true,
        endTime: true,
        location: true,
        track: { select: { name: true } },
        topics: { select: { id: true, title: true, speakers: { select: { speaker: { select: { firstName: true, lastName: true } } } } } },
      },
    });
    return { success: true, session };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_session failed");
    return { error: "Failed to create session" };
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
      select: { id: true, name: true, _count: { select: { topics: true } } },
    });
    if (!session) return { error: `Session ${sessionId} not found in this event` };

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

    const topic = await db.sessionTopic.create({
      data: {
        sessionId,
        title,
        duration: input.duration ? Number(input.duration) : null,
        sortOrder: session._count.topics, // append at end
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
    if (!sessionId) return { error: "sessionId is required" };

    const existing = await db.eventSession.findFirst({
      where: { id: sessionId, event: { organizationId: ctx.organizationId } },
      select: {
        id: true,
        eventId: true,
        name: true,
        startTime: true,
        endTime: true,
        event: { select: { startDate: true, endDate: true, timezone: true } },
      },
    });
    if (!existing) return { error: `Session ${sessionId} not found or access denied` };

    const status = input.status ? String(input.status) : undefined;
    if (status && !SESSION_STATUSES.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...SESSION_STATUSES].join(", ")}` };
    }

    const updates: Prisma.EventSessionUpdateInput = {};
    if (input.name != null) updates.name = String(input.name).slice(0, 255);
    if (input.description != null) updates.description = String(input.description).slice(0, 5000);
    if (input.location != null) updates.location = String(input.location).slice(0, 255);
    if (input.capacity != null) updates.capacity = Math.max(0, Number(input.capacity));
    if (status) updates.status = status as never;

    let newStart = existing.startTime;
    let newEnd = existing.endTime;
    if (input.startTime != null) {
      const s = new Date(String(input.startTime));
      if (isNaN(s.getTime())) return { error: "startTime is not a valid ISO 8601 date" };
      updates.startTime = s;
      newStart = s;
    }
    if (input.endTime != null) {
      const e = new Date(String(input.endTime));
      if (isNaN(e.getTime())) return { error: "endTime is not a valid ISO 8601 date" };
      updates.endTime = e;
      newEnd = e;
    }

    if (newEnd < newStart) return { error: "endTime must be on or after startTime" };

    // Session must fall within the parent event's date range, compared as LOCAL
    // DATES in the event's timezone (default Asia/Dubai). UTC comparison would
    // incorrectly reject late-evening sessions on the last event day.
    const timezone = existing.event.timezone || "Asia/Dubai";
    const toLocalDate = (d: Date): string =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);
    const eventStartDate = toLocalDate(existing.event.startDate);
    const eventEndDate = toLocalDate(existing.event.endDate);
    const newStartDate = toLocalDate(newStart);
    const newEndDate = toLocalDate(newEnd);
    if (newStartDate < eventStartDate || newEndDate > eventEndDate) {
      return {
        error: `Session must fall within event dates (${eventStartDate} to ${eventEndDate} ${timezone})`,
      };
    }

    if (input.trackId !== undefined) {
      if (input.trackId === null || input.trackId === "") {
        updates.track = { disconnect: true };
      } else {
        const trackId = String(input.trackId);
        const track = await db.track.findFirst({
          where: { id: trackId, eventId: existing.eventId },
          select: { id: true },
        });
        if (!track) return { error: `trackId ${trackId} not found in this event` };
        updates.track = { connect: { id: trackId } };
      }
    }

    if (Object.keys(updates).length === 0) {
      return { error: "No fields provided to update" };
    }

    const updated = await db.eventSession.update({
      where: { id: sessionId },
      data: updates,
      select: {
        id: true,
        name: true,
        startTime: true,
        endTime: true,
        location: true,
        capacity: true,
        status: true,
        trackId: true,
      },
    });

    await db.auditLog.create({
      data: {
        eventId: existing.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "EventSession",
        entityId: sessionId,
        changes: { source: "mcp", fieldsChanged: Object.keys(updates) },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_session audit-log-failed"));

    return { success: true, session: updated };
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
      "Create a new session. Requires name, startTime, and endTime (ISO 8601 datetime strings). Optionally assign to a trackId, location, description, speakerIds, sessionRoles (with role per speaker), and topics (with per-topic speakers).",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Session name" },
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
];

export const SESSION_EXECUTORS: Record<string, ToolExecutor> = {
  list_sessions: listSessions,
  create_session: createSession,
  update_session: updateSession,
  add_topic_to_session: addTopicToSession,
  list_live_sessions_now: listLiveSessionsNow,
};
