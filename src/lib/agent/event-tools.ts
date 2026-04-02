import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { checkRateLimit } from "@/lib/security";
import { apiLogger } from "@/lib/logger";

const SPEAKER_STATUSES = new Set(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]);
const REGISTRATION_STATUSES = new Set(["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"]);

export interface AgentContext {
  eventId: string;
  organizationId: string;
  userId: string;
}

type ToolExecutor = (
  input: Record<string, unknown>,
  ctx: AgentContext
) => Promise<unknown>;

// ─── Tool Definitions (JSON Schema for Anthropic API) ────────────────────────

export const AGENT_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_event_info",
    description:
      "Get current event details including name, dates, venue, status, specialty, and counts of registrations, speakers, sessions, and tracks.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_tracks",
    description:
      "List all tracks for this event with their names, colors, descriptions, and session counts.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "create_track",
    description:
      "Create a new track for organizing sessions. Provide a name, optional color (hex like #3B82F6), and optional description.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Track name" },
        color: {
          type: "string",
          description: "Hex color code, e.g. #3B82F6",
          pattern: "^#[0-9A-Fa-f]{6}$",
        },
        description: { type: "string", description: "Optional description" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_speakers",
    description:
      "List speakers for this event. Optionally filter by status: INVITED, CONFIRMED, DECLINED, or CANCELLED.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"],
          description: "Filter by speaker status",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 50, max 200)",
        },
      },
      required: [],
    },
  },
  {
    name: "create_speaker",
    description:
      "Add a new speaker to the event. Email, firstName, and lastName are required.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: { type: "string", description: "Speaker email address" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        title: {
          type: "string",
          enum: ["DR", "MR", "MRS", "MS", "PROF"],
          description: "Honorific title",
        },
        bio: { type: "string" },
        organization: { type: "string" },
        jobTitle: { type: "string" },
        specialty: { type: "string" },
        status: {
          type: "string",
          enum: ["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"],
          description: "Default is INVITED",
        },
      },
      required: ["email", "firstName", "lastName"],
    },
  },
  {
    name: "list_registrations",
    description:
      "List registrations for this event. Optionally filter by status or ticketTypeId.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"],
        },
        ticketTypeId: { type: "string", description: "Filter by ticket type ID" },
        limit: {
          type: "number",
          description: "Max results to return (default 50, max 200)",
        },
      },
      required: [],
    },
  },
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
      "Create a new session. Requires name, startTime, and endTime (ISO 8601 datetime strings). Optionally assign to a trackId, location, description, and speakerIds.",
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
          description: "Speaker IDs to assign as speakers",
        },
      },
      required: ["name", "startTime", "endTime"],
    },
  },
  {
    name: "list_ticket_types",
    description: "List all registration/ticket types for this event.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "send_bulk_email",
    description:
      "Send a bulk email to speakers or registrants. IMPORTANT: Before calling this tool, inform the user what you plan to send and to how many recipients. Specify recipientType (speakers or registrations), emailType, a subject, and HTML message content.",
    input_schema: {
      type: "object" as const,
      properties: {
        recipientType: {
          type: "string",
          enum: ["speakers", "registrations"],
          description: "Who to send the email to",
        },
        emailType: {
          type: "string",
          enum: ["custom", "invitation", "confirmation", "reminder"],
          description: "Type of email",
        },
        subject: { type: "string", description: "Email subject line" },
        htmlMessage: {
          type: "string",
          description: "HTML content of the email body",
        },
        statusFilter: {
          type: "string",
          description:
            "Optional status filter: e.g. CONFIRMED for registrations, INVITED for speakers",
        },
      },
      required: ["recipientType", "emailType", "subject", "htmlMessage"],
    },
  },
];

// ─── Tool Executors ───────────────────────────────────────────────────────────

const listEventInfo: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        startDate: true,
        endDate: true,
        venue: true,
        city: true,
        country: true,
        specialty: true,
        eventType: true,
        _count: {
          select: {
            registrations: true,
            speakers: true,
            eventSessions: true,
            tracks: true,
          },
        },
      },
    });
    if (!event) return { error: "Event not found" };
    return event;
  } catch (err) {
    apiLogger.error({ err }, "agent:list_event_info failed");
    return { error: "Failed to fetch event info" };
  }
};

const listTracks: ToolExecutor = async (_input, ctx) => {
  try {
    const tracks = await db.track.findMany({
      where: { eventId: ctx.eventId },
      select: {
        id: true,
        name: true,
        color: true,
        description: true,
        sortOrder: true,
        _count: { select: { eventSessions: true } },
      },
      orderBy: { sortOrder: "asc" },
    });
    return { tracks, total: tracks.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_tracks failed");
    return { error: "Failed to fetch tracks" };
  }
};

const createTrack: ToolExecutor = async (input, ctx) => {
  try {
    const name = String(input.name ?? "").trim();
    if (!name) return { error: "Track name is required" };

    const color = String(input.color ?? "#3B82F6");
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      return { error: "Color must be a valid hex code like #3B82F6" };
    }

    // Get next sort order
    const maxOrder = await db.track.findFirst({
      where: { eventId: ctx.eventId },
      select: { sortOrder: true },
      orderBy: { sortOrder: "desc" },
    });
    const sortOrder = (maxOrder?.sortOrder ?? -1) + 1;

    const track = await db.track.create({
      data: {
        eventId: ctx.eventId,
        name,
        color,
        description: input.description ? String(input.description) : null,
        sortOrder,
      },
      select: { id: true, name: true, color: true, description: true },
    });
    return { success: true, track };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_track failed");
    return { error: "Failed to create track" };
  }
};

const listSpeakers: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 200);
    const statusValue = input.status ? String(input.status) : undefined;
    if (statusValue && !SPEAKER_STATUSES.has(statusValue)) {
      return { error: `Invalid status "${statusValue}". Must be one of: ${[...SPEAKER_STATUSES].join(", ")}` };
    }
    const speakers = await db.speaker.findMany({
      where: {
        eventId: ctx.eventId,
        ...(statusValue ? { status: statusValue as never } : {}),
      },
      select: {
        id: true,
        title: true,
        firstName: true,
        lastName: true,
        email: true,
        organization: true,
        jobTitle: true,
        specialty: true,
        status: true,
      },
      take: limit,
      orderBy: { createdAt: "desc" },
    });
    return { speakers, total: speakers.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_speakers failed");
    return { error: "Failed to fetch speakers" };
  }
};

const createSpeaker: ToolExecutor = async (input, ctx) => {
  try {
    const email = String(input.email ?? "").trim().toLowerCase();
    const firstName = String(input.firstName ?? "").trim();
    const lastName = String(input.lastName ?? "").trim();
    if (!email || !firstName || !lastName) {
      return { error: "email, firstName, and lastName are required" };
    }

    const speaker = await db.speaker.create({
      data: {
        eventId: ctx.eventId,
        email,
        firstName,
        lastName,
        title: input.title as never ?? null,
        bio: input.bio ? String(input.bio) : null,
        organization: input.organization ? String(input.organization) : null,
        jobTitle: input.jobTitle ? String(input.jobTitle) : null,
        specialty: input.specialty ? String(input.specialty) : null,
        status: (input.status as never) ?? "INVITED",
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
      },
    });
    return { success: true, speaker };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Unique constraint") &&
      err.message.includes("email")
    ) {
      return {
        error: `A speaker with email ${input.email} already exists for this event`,
      };
    }
    apiLogger.error({ err }, "agent:create_speaker failed");
    return { error: "Failed to create speaker" };
  }
};

const listRegistrations: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 200);
    const statusValue = input.status ? String(input.status) : undefined;
    if (statusValue && !REGISTRATION_STATUSES.has(statusValue)) {
      return { error: `Invalid status "${statusValue}". Must be one of: ${[...REGISTRATION_STATUSES].join(", ")}` };
    }
    const registrations = await db.registration.findMany({
      where: {
        eventId: ctx.eventId,
        ...(statusValue ? { status: statusValue as never } : {}),
        ...(input.ticketTypeId
          ? { ticketTypeId: String(input.ticketTypeId) }
          : {}),
      },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        createdAt: true,
        attendee: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            organization: true,
          },
        },
        ticketType: { select: { name: true } },
      },
      take: limit,
      orderBy: { createdAt: "desc" },
    });
    return { registrations, total: registrations.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_registrations failed");
    return { error: "Failed to fetch registrations" };
  }
};

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

    // Validate trackId belongs to this event if provided
    if (input.trackId) {
      const track = await db.track.findFirst({
        where: { id: String(input.trackId), eventId: ctx.eventId },
        select: { id: true },
      });
      if (!track) return { error: `Track with ID ${input.trackId} not found for this event` };
    }

    const rawSpeakerIds = Array.isArray(input.speakerIds)
      ? (input.speakerIds as string[]).slice(0, 50) // cap at 50
      : [];

    // Validate all speakerIds belong to this event — never trust model-supplied IDs
    let speakerIds: string[] = [];
    if (rawSpeakerIds.length > 0) {
      const validSpeakers = await db.speaker.findMany({
        where: { id: { in: rawSpeakerIds }, eventId: ctx.eventId },
        select: { id: true },
      });
      speakerIds = validSpeakers.map((s) => s.id);
      if (speakerIds.length !== rawSpeakerIds.length) {
        const invalid = rawSpeakerIds.filter((id) => !speakerIds.includes(id));
        return { error: `Speaker IDs not found in this event: ${invalid.join(", ")}` };
      }
    }

    const session = await db.eventSession.create({
      data: {
        eventId: ctx.eventId,
        name,
        startTime,
        endTime,
        trackId: input.trackId ? String(input.trackId) : null,
        location: input.location ? String(input.location) : null,
        description: input.description ? String(input.description) : null,
        speakers: speakerIds.length
          ? {
              create: speakerIds.map((sid) => ({
                speakerId: sid,
                role: "SPEAKER" as const,
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
      },
    });
    return { success: true, session };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_session failed");
    return { error: "Failed to create session" };
  }
};

const listTicketTypes: ToolExecutor = async (_input, ctx) => {
  try {
    const ticketTypes = await db.ticketType.findMany({
      where: { eventId: ctx.eventId },
      select: {
        id: true,
        name: true,
        description: true,
        isDefault: true,
        _count: { select: { registrations: true } },
      },
      orderBy: { sortOrder: "asc" },
    });
    return { ticketTypes, total: ticketTypes.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_ticket_types failed");
    return { error: "Failed to fetch ticket types" };
  }
};

const sendBulkEmail: ToolExecutor = async (input, ctx) => {
  try {
    // Rate limit: 10 bulk email sends per event per hour
    const rl = checkRateLimit({
      key: `agent-email-${ctx.eventId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      return {
        error: `Bulk email rate limit reached. Please wait ${rl.retryAfterSeconds} seconds before sending again.`,
      };
    }

    const subject = String(input.subject ?? "").trim();
    const htmlMessage = String(input.htmlMessage ?? "").trim();
    if (!subject || !htmlMessage) {
      return { error: "subject and htmlMessage are required" };
    }

    const recipientType = String(input.recipientType);
    const rawStatusFilter = input.statusFilter ? String(input.statusFilter) : undefined;

    // Validate statusFilter against known enums
    if (rawStatusFilter) {
      const validSet = recipientType === "speakers" ? SPEAKER_STATUSES : REGISTRATION_STATUSES;
      if (!validSet.has(rawStatusFilter)) {
        return { error: `Invalid statusFilter "${rawStatusFilter}". Must be one of: ${[...validSet].join(", ")}` };
      }
    }
    const statusFilter = rawStatusFilter;

    let recipients: { email: string; name: string }[] = [];

    if (recipientType === "speakers") {
      const speakers = await db.speaker.findMany({
        where: {
          eventId: ctx.eventId,
          ...(statusFilter ? { status: statusFilter as never } : {}),
        },
        select: { email: true, firstName: true, lastName: true },
      });
      recipients = speakers.map((s) => ({
        email: s.email,
        name: `${s.firstName} ${s.lastName}`.trim(),
      }));
    } else if (recipientType === "registrations") {
      const registrations = await db.registration.findMany({
        where: {
          eventId: ctx.eventId,
          ...(statusFilter ? { status: statusFilter as never } : {}),
        },
        select: {
          attendee: { select: { email: true, firstName: true, lastName: true } },
        },
      });
      recipients = registrations.map((r) => ({
        email: r.attendee.email,
        name: `${r.attendee.firstName} ${r.attendee.lastName}`.trim(),
      }));
    } else {
      return { error: "recipientType must be 'speakers' or 'registrations'" };
    }

    if (recipients.length === 0) {
      return { error: "No recipients found matching the given filters" };
    }

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const recipient of recipients) {
      try {
        await sendEmail({
          to: [{ email: recipient.email, name: recipient.name }],
          subject,
          htmlContent: htmlMessage,
        });
        sent++;
      } catch (emailErr) {
        failed++;
        errors.push(`Failed to send to ${recipient.email}`);
        apiLogger.warn({ emailErr, to: recipient.email }, "agent:send_bulk_email individual send failed");
      }
    }

    return {
      success: true,
      sent,
      failed,
      total: recipients.length,
      errors: errors.slice(0, 5),
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:send_bulk_email failed");
    return { error: "Failed to send bulk email" };
  }
};

// ─── Executor Map ─────────────────────────────────────────────────────────────

export const TOOL_EXECUTOR_MAP: Record<string, ToolExecutor> = {
  list_event_info: listEventInfo,
  list_tracks: listTracks,
  create_track: createTrack,
  list_speakers: listSpeakers,
  create_speaker: createSpeaker,
  list_registrations: listRegistrations,
  list_sessions: listSessions,
  create_session: createSession,
  list_ticket_types: listTicketTypes,
  send_bulk_email: sendBulkEmail,
};
