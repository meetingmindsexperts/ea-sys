import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { readWebinarSettings, readSponsors, SPONSOR_TIERS, type SponsorEntry } from "@/lib/webinar";
import type { ToolExecutor } from "./_shared";

const listZoomMeetings: ToolExecutor = async (_input, ctx) => {
  try {
    const meetings = await db.zoomMeeting.findMany({
      where: { eventId: ctx.eventId },
      select: {
        id: true,
        zoomMeetingId: true,
        meetingType: true,
        joinUrl: true,
        passcode: true,
        status: true,
        isRecurring: true,
        duration: true,
        session: { select: { id: true, name: true, startTime: true, endTime: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    if (meetings.length === 0) {
      return { message: "No Zoom meetings linked to sessions in this event." };
    }

    return {
      count: meetings.length,
      meetings: meetings.map((m) => ({
        id: m.id,
        zoomMeetingId: m.zoomMeetingId,
        meetingType: m.meetingType,
        status: m.status,
        joinUrl: m.joinUrl,
        passcode: m.passcode,
        isRecurring: m.isRecurring,
        duration: m.duration,
        sessionName: m.session.name,
        sessionId: m.session.id,
        sessionStart: m.session.startTime?.toISOString(),
        sessionEnd: m.session.endTime?.toISOString(),
      })),
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_zoom_meetings failed");
    return { error: "Failed to list Zoom meetings" };
  }
};

const createZoomMeetingTool: ToolExecutor = async (input, ctx) => {
  try {
    const sessionId = input.sessionId as string;
    const meetingType = (input.meetingType as string) || "MEETING";
    const passcode = input.passcode as string | undefined;
    const waitingRoom = input.waitingRoom !== false;

    if (!sessionId) return { error: "sessionId is required" };
    if (!["MEETING", "WEBINAR", "WEBINAR_SERIES"].includes(meetingType)) {
      return { error: "meetingType must be MEETING, WEBINAR, or WEBINAR_SERIES" };
    }

    // Check if Zoom is configured
    const { isZoomConfigured } = await import("@/lib/zoom");
    const configured = await isZoomConfigured(ctx.organizationId);
    if (!configured) {
      return { error: "Zoom is not configured for this organization. Ask an admin to set up Zoom credentials in Organization Settings → Integrations." };
    }

    // Verify session exists and has no zoom meeting
    const [session, existing] = await Promise.all([
      db.eventSession.findFirst({
        where: { id: sessionId, eventId: ctx.eventId },
        select: { id: true, name: true, startTime: true, endTime: true, description: true },
      }),
      db.zoomMeeting.findUnique({ where: { sessionId } }),
    ]);

    if (!session) return { error: "Session not found in this event" };
    if (existing) return { error: `Session "${session.name}" already has a Zoom meeting linked (ID: ${existing.zoomMeetingId})` };

    // Get event timezone
    const event = await db.event.findFirst({
      where: { id: ctx.eventId },
      select: { timezone: true },
    });

    const duration = Math.ceil(
      (session.endTime.getTime() - session.startTime.getTime()) / 60000
    );

    const { createZoomMeeting, createZoomWebinar } = await import("@/lib/zoom");
    const meetingParams = {
      topic: session.name,
      startTime: session.startTime.toISOString(),
      duration,
      timezone: event?.timezone || "UTC",
      passcode,
      waitingRoom,
      autoRecording: "none" as const,
      agenda: session.description || undefined,
    };

    ctx.counters.creates++;

    let zoomResponse;
    if (meetingType === "MEETING") {
      zoomResponse = await createZoomMeeting(ctx.organizationId, meetingParams);
    } else {
      zoomResponse = await createZoomWebinar(ctx.organizationId, meetingParams);
    }

    const zoomMeeting = await db.zoomMeeting.create({
      data: {
        sessionId,
        eventId: ctx.eventId,
        zoomMeetingId: String(zoomResponse.id),
        meetingType: meetingType as "MEETING" | "WEBINAR" | "WEBINAR_SERIES",
        joinUrl: zoomResponse.join_url,
        startUrl: zoomResponse.start_url,
        passcode: zoomResponse.password || passcode,
        duration,
        zoomResponse: JSON.parse(JSON.stringify(zoomResponse)),
      },
    });

    apiLogger.info(
      { zoomMeetingId: zoomMeeting.zoomMeetingId, sessionId, meetingType, userId: ctx.userId },
      "agent:zoom-meeting-created",
    );

    return {
      message: `Created Zoom ${meetingType.toLowerCase()} for session "${session.name}"`,
      zoomMeetingId: zoomMeeting.zoomMeetingId,
      joinUrl: zoomMeeting.joinUrl,
      meetingType: zoomMeeting.meetingType,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_zoom_meeting failed");
    const message = err instanceof Error ? err.message : "Failed to create Zoom meeting";
    return { error: message };
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// MCP Expansion (April 2026) — 22 new tools across 4 tranches
// ═══════════════════════════════════════════════════════════════════════════════
// Tranche 0: create_event (the obvious missing CRUD tool)
// Tranche A: orchestration reads (5) — composite answers for common questions
// Tranche B: actions (4) — plug the read/write asymmetry with update tools
// Tranche C: recently shipped features (12) — webinar + sponsors + agreement
//                                              template + promo codes + scheduled
// ═══════════════════════════════════════════════════════════════════════════════

const getWebinarInfo: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true, name: true, eventType: true, settings: true, startDate: true, endDate: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    const webinar = readWebinarSettings(event.settings);
    if (!webinar) {
      return {
        event: { id: event.id, name: event.name, eventType: event.eventType },
        webinar: null,
        message: "This event has no webinar configuration. Only WEBINAR-type events have this.",
      };
    }

    let anchorSession = null;
    let zoomMeeting = null;
    if (webinar.sessionId) {
      anchorSession = await db.eventSession.findFirst({
        where: { id: webinar.sessionId, eventId: event.id },
        select: { id: true, name: true, startTime: true, endTime: true, location: true },
      });
      zoomMeeting = await db.zoomMeeting.findUnique({
        where: { sessionId: webinar.sessionId },
        select: {
          id: true,
          zoomMeetingId: true,
          meetingType: true,
          joinUrl: true,
          startUrl: true,
          passcode: true,
          duration: true,
          recordingStatus: true,
          recordingUrl: true,
          recordingFetchedAt: true,
          lastAttendanceSyncAt: true,
        },
      });
    }

    return {
      event: { id: event.id, name: event.name, eventType: event.eventType },
      webinar,
      anchorSession,
      zoomMeeting,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:get_webinar_info failed");
    return { error: "Failed to fetch webinar info" };
  }
};

const listWebinarAttendance: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 500);

    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true, settings: true, _count: { select: { registrations: true } } },
    });
    if (!event) return { error: "Event not found or access denied" };

    const webinar = readWebinarSettings(event.settings);
    if (!webinar?.sessionId) {
      return { error: "This event has no webinar configuration" };
    }

    const zoomMeeting = await db.zoomMeeting.findUnique({
      where: { sessionId: webinar.sessionId },
      select: { id: true },
    });
    if (!zoomMeeting) {
      return { error: "No Zoom webinar is attached to the anchor session" };
    }

    const [attendance, totalAttendance] = await Promise.all([
      db.zoomAttendance.findMany({
        where: { zoomMeetingId: zoomMeeting.id },
        select: {
          id: true,
          name: true,
          email: true,
          joinTime: true,
          leaveTime: true,
          durationSeconds: true,
          attentivenessScore: true,
          registrationId: true,
        },
        orderBy: { durationSeconds: "desc" },
        take: limit,
      }),
      db.zoomAttendance.count({ where: { zoomMeetingId: zoomMeeting.id } }),
    ]);

    // Count distinct attendees (participantId) to get unique count vs segment count
    const distinctAttendees = new Set(attendance.map((a) => a.email?.toLowerCase() ?? a.name));

    const totalWatchSeconds = attendance.reduce((s, a) => s + (a.durationSeconds ?? 0), 0);
    const attended = distinctAttendees.size;

    return {
      zoomMeetingId: zoomMeeting.id,
      registered: event._count.registrations,
      attended,
      totalSegments: totalAttendance,
      attendanceRate: event._count.registrations === 0
        ? 0
        : Math.round((attended / event._count.registrations) * 100),
      avgWatchTimeSeconds: attended === 0 ? 0 : Math.round(totalWatchSeconds / attended),
      rows: attendance,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_webinar_attendance failed");
    return { error: "Failed to fetch webinar attendance" };
  }
};

const listWebinarEngagement: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true, settings: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    const webinar = readWebinarSettings(event.settings);
    if (!webinar?.sessionId) return { error: "This event has no webinar configuration" };

    const zoomMeeting = await db.zoomMeeting.findUnique({
      where: { sessionId: webinar.sessionId },
      select: { id: true },
    });
    if (!zoomMeeting) return { error: "No Zoom webinar attached" };

    const [polls, questions] = await Promise.all([
      db.webinarPoll.findMany({
        where: { zoomMeetingId: zoomMeeting.id },
        select: {
          id: true,
          title: true,
          questions: true,
          responses: {
            select: { participantName: true, answers: true, submittedAt: true },
          },
        },
      }),
      db.webinarQuestion.findMany({
        where: { zoomMeetingId: zoomMeeting.id },
        select: {
          id: true,
          askerName: true,
          askerEmail: true,
          question: true,
          answer: true,
          answeredByName: true,
          askedAt: true,
        },
        orderBy: { askedAt: "asc" },
      }),
    ]);

    return {
      polls: polls.map((p) => ({
        id: p.id,
        title: p.title,
        questions: p.questions,
        responseCount: p.responses.length,
        responses: p.responses,
      })),
      questions,
      totalPolls: polls.length,
      totalQuestions: questions.length,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_webinar_engagement failed");
    return { error: "Failed to fetch webinar engagement" };
  }
};

const listSponsors: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { settings: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    const sponsors = readSponsors(event.settings);
    const grouped: Record<string, SponsorEntry[]> = {};
    for (const s of sponsors) {
      const tier = s.tier ?? "exhibitor";
      if (!grouped[tier]) grouped[tier] = [];
      grouped[tier].push(s);
    }

    return {
      sponsors,
      total: sponsors.length,
      byTier: grouped,
      availableTiers: SPONSOR_TIERS,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_sponsors failed");
    return { error: "Failed to fetch sponsors" };
  }
};

const upsertSponsors: ToolExecutor = async (input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true, settings: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    if (!Array.isArray(input.sponsors)) {
      return { error: "sponsors must be an array" };
    }

    const safeUrl = (raw: unknown, opts: { allowRelative: boolean }): string | undefined => {
      if (raw == null) return undefined;
      const s = String(raw).trim();
      if (!s) return undefined;
      if (opts.allowRelative && s.startsWith("/")) return s;
      try {
        const u = new URL(s);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          throw new Error(`Rejected URL scheme: ${u.protocol}`);
        }
        return u.toString();
      } catch {
        throw new Error(`Invalid URL: ${s}`);
      }
    };

    const tierSet = new Set<string>(SPONSOR_TIERS);
    const sanitized: SponsorEntry[] = [];
    for (let i = 0; i < (input.sponsors as unknown[]).length; i++) {
      const raw = (input.sponsors as unknown[])[i];
      if (!raw || typeof raw !== "object") return { error: `sponsors[${i}] is not an object` };
      const r = raw as Record<string, unknown>;
      const name = String(r.name ?? "").trim();
      if (!name) return { error: `sponsors[${i}].name is required` };
      const tier = r.tier ? String(r.tier) : undefined;
      if (tier && !tierSet.has(tier)) {
        return { error: `sponsors[${i}].tier must be one of: ${SPONSOR_TIERS.join(", ")}` };
      }
      let logoUrl: string | undefined;
      let websiteUrl: string | undefined;
      try {
        logoUrl = safeUrl(r.logoUrl, { allowRelative: true });
        websiteUrl = safeUrl(r.websiteUrl, { allowRelative: false });
      } catch (e) {
        return { error: `sponsors[${i}]: ${e instanceof Error ? e.message : "invalid URL"}` };
      }

      sanitized.push({
        id: r.id ? String(r.id) : `sponsor-${crypto.randomUUID()}`,
        name: name.slice(0, 255),
        tier: tier as SponsorEntry["tier"],
        logoUrl,
        websiteUrl,
        description: r.description ? String(r.description).slice(0, 1000) : undefined,
        sortOrder: i, // Always reassign from array index
      });
    }

    const currentSettings = (event.settings as Record<string, unknown>) ?? {};
    const nextSettings = { ...currentSettings, sponsors: sanitized };

    await db.event.update({
      where: { id: event.id },
      data: { settings: nextSettings as unknown as Prisma.InputJsonValue },
    });

    await db.auditLog.create({
      data: {
        eventId: event.id,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Event",
        entityId: event.id,
        changes: { source: "mcp", field: "settings.sponsors", count: sanitized.length },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:upsert_sponsors audit-log-failed"));

    return { success: true, sponsors: sanitized, total: sanitized.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:upsert_sponsors failed");
    return { error: err instanceof Error ? err.message : "Failed to update sponsors" };
  }
};

export const WEBINAR_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_zoom_meetings",
    description: "List all sessions that have a linked Zoom meeting or webinar. Shows meeting type, status, join URL.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "create_zoom_meeting",
    description: "Create a Zoom meeting or webinar linked to an existing session. Requires Zoom to be configured for the organization and enabled for the event.",
    input_schema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "ID of the session to link the Zoom meeting to" },
        meetingType: { type: "string", enum: ["MEETING", "WEBINAR", "WEBINAR_SERIES"], description: "Type of Zoom meeting (default: MEETING)" },
        passcode: { type: "string", description: "Optional meeting passcode (max 10 chars)" },
        waitingRoom: { type: "boolean", description: "Enable waiting room (default: true)" },
      },
      required: ["sessionId"],
    },
  },
];

export const WEBINAR_EXECUTORS: Record<string, ToolExecutor> = {
  list_zoom_meetings: listZoomMeetings,
  create_zoom_meeting: createZoomMeetingTool,
  get_webinar_info: getWebinarInfo,
  list_webinar_attendance: listWebinarAttendance,
  list_webinar_engagement: listWebinarEngagement,
  list_sponsors: listSponsors,
  upsert_sponsors: upsertSponsors,
};
