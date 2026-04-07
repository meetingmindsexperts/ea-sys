import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { checkRateLimit } from "@/lib/security";
import { apiLogger } from "@/lib/logger";
import { getNextSerialId } from "@/lib/registration-serial";
import { sanitizeHtml } from "@/lib/sanitize";

const SPEAKER_STATUSES = new Set(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]);
const REGISTRATION_STATUSES = new Set(["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"]);
const MANUAL_REGISTRATION_STATUSES = new Set(["PENDING", "CONFIRMED", "WAITLISTED"]);
const TITLE_VALUES = new Set(["DR", "MR", "MRS", "MS", "PROF"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_RECIPIENTS = 500;

export interface AgentContext {
  eventId: string;
  organizationId: string;
  userId: string;
  counters: { creates: number; emailsSent: number };
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
      "List registrations for this event. Optionally filter by status, paymentStatus, or ticketTypeId.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"],
        },
        paymentStatus: {
          type: "string",
          enum: ["UNPAID", "PENDING", "PAID", "REFUNDED", "COMPLIMENTARY"],
          description: "Filter by payment status, e.g. UNPAID to find who hasn't paid",
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
    name: "list_ticket_types",
    description: "List all registration/ticket types for this event.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "create_ticket_type",
    description:
      "Create a new registration/ticket type for this event if one with the same name does not already exist. Automatically creates Early Bird, Standard, and Onsite pricing tiers at $0 and inactive — organizers can set prices and activate tiers later.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Ticket type name, e.g. 'Standard Delegate', 'VIP', 'Student'" },
        description: { type: "string", description: "Optional description" },
        isDefault: { type: "boolean", description: "Whether this is the default ticket type (default: false)" },
      },
      required: ["name"],
    },
  },
  {
    name: "create_registration",
    description:
      "Manually add a registration for an attendee. Requires email, firstName, lastName, and ticketTypeId (use list_ticket_types to get IDs). Optionally specify pricingTierId, status (default CONFIRMED), title, organization, jobTitle, specialty.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: { type: "string", description: "Attendee email address" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        ticketTypeId: { type: "string", description: "ID of the ticket type (use list_ticket_types to get IDs)" },
        pricingTierId: { type: "string", description: "Optional pricing tier ID" },
        status: {
          type: "string",
          enum: ["PENDING", "CONFIRMED", "WAITLISTED"],
          description: "Registration status (default: CONFIRMED)",
        },
        title: {
          type: "string",
          enum: ["DR", "MR", "MRS", "MS", "PROF"],
        },
        organization: { type: "string" },
        jobTitle: { type: "string" },
        specialty: { type: "string" },
      },
      required: ["email", "firstName", "lastName", "ticketTypeId"],
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
  // ─── Abstract Management Tools ──────────────────────────────────────────────
  {
    name: "list_abstract_themes",
    description: "List abstract themes configured for this event.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "create_abstract_theme",
    description: "Create an abstract theme for this event.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Theme name" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_review_criteria",
    description: "List review criteria configured for this event, including weights.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "create_review_criterion",
    description: "Create a review criterion for this event.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Criterion name (e.g. Originality, Methodology)" },
        weight: { type: "number", description: "Weight for scoring (e.g. 1, 2, 3). Higher = more important" },
      },
      required: ["name", "weight"],
    },
  },
  {
    name: "list_abstracts",
    description: "List abstract submissions for this event. Optionally filter by status or theme.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED", "WITHDRAWN"],
        },
        themeId: { type: "string", description: "Filter by abstract theme ID" },
        limit: { type: "number", description: "Max results (default 50, max 200)" },
      },
      required: [],
    },
  },
  {
    name: "update_abstract_status",
    description: "Update the status of an abstract submission (e.g. accept, reject, request revision).",
    input_schema: {
      type: "object" as const,
      properties: {
        abstractId: { type: "string", description: "Abstract ID" },
        status: {
          type: "string",
          enum: ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"],
        },
        reviewNotes: { type: "string", description: "Optional notes for the author" },
      },
      required: ["abstractId", "status"],
    },
  },
  // ─── Accommodation Tools ────────────────────────────────────────────────────
  {
    name: "list_hotels",
    description: "List hotels configured for this event.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "create_hotel",
    description: "Add a hotel for this event.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Hotel name" },
        address: { type: "string" },
        stars: { type: "number", description: "Star rating (1-5)" },
        contactEmail: { type: "string" },
        contactPhone: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_accommodations",
    description: "List room bookings for this event with guest details.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["PENDING", "CONFIRMED", "CANCELLED", "CHECKED_IN", "CHECKED_OUT"] },
        limit: { type: "number", description: "Max results (default 50, max 200)" },
      },
      required: [],
    },
  },
  // ─── Media Tools ────────────────────────────────────────────────────────────
  {
    name: "list_media",
    description: "List media files in the organization library. Optionally filter by event.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max results (default 50)" },
      },
      required: [],
    },
  },
  // ─── Check-in Tool ──────────────────────────────────────────────────────────
  {
    name: "check_in_registration",
    description: "Mark a registration as checked in at the event.",
    input_schema: {
      type: "object" as const,
      properties: {
        registrationId: { type: "string", description: "Registration ID to check in" },
      },
      required: ["registrationId"],
    },
  },
  // ─── Contact Tools ──────────────────────────────────────────────────────────
  {
    name: "list_contacts",
    description: "List contacts in the organization. Optionally filter by tag or search.",
    input_schema: {
      type: "object" as const,
      properties: {
        search: { type: "string", description: "Search by name or email" },
        tag: { type: "string", description: "Filter by tag" },
        limit: { type: "number", description: "Max results (default 50, max 200)" },
      },
      required: [],
    },
  },
  {
    name: "create_contact",
    description: "Create a new contact in the organization.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: { type: "string" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        organization: { type: "string" },
        jobTitle: { type: "string" },
        phone: { type: "string" },
        city: { type: "string" },
        country: { type: "string" },
        tags: { type: "array", items: { type: "string" }, description: "Tags to assign" },
      },
      required: ["email", "firstName", "lastName"],
    },
  },
  // ─── Reviewer Tools ─────────────────────────────────────────────────────────
  {
    name: "list_reviewers",
    description: "List reviewers assigned to this event.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  // ─── Invoice Tools ──────────────────────────────────────────────────────────
  {
    name: "list_invoices",
    description: "List invoices, receipts, and credit notes for this event.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: { type: "string", enum: ["INVOICE", "RECEIPT", "CREDIT_NOTE"] },
        status: { type: "string", enum: ["DRAFT", "SENT", "PAID", "OVERDUE", "CANCELLED", "REFUNDED"] },
        limit: { type: "number", description: "Max results (default 50, max 200)" },
      },
      required: [],
    },
  },
  // ─── Email Template Tools ───────────────────────────────────────────────────
  {
    name: "list_email_templates",
    description: "List email templates configured for this event.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  // ─── Event Stats Tool ───────────────────────────────────────────────────────
  {
    name: "get_event_stats",
    description: "Get comprehensive event statistics: registration counts by status, payment breakdown, speaker counts, session counts, abstract counts.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  // ─── Zoom Tools ───────────────────────────────────────────────────────────
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
    if (!EMAIL_RE.test(email)) return { error: "Invalid email format" };

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
    const PAYMENT_STATUSES = new Set(["UNPAID", "PENDING", "PAID", "REFUNDED", "COMPLIMENTARY"]);
    const paymentStatusValue = input.paymentStatus ? String(input.paymentStatus) : undefined;
    if (paymentStatusValue && !PAYMENT_STATUSES.has(paymentStatusValue)) {
      return { error: `Invalid paymentStatus "${paymentStatusValue}". Must be one of: ${[...PAYMENT_STATUSES].join(", ")}` };
    }
    const registrations = await db.registration.findMany({
      where: {
        eventId: ctx.eventId,
        ...(statusValue ? { status: statusValue as never } : {}),
        ...(paymentStatusValue ? { paymentStatus: paymentStatusValue as never } : {}),
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

const createTicketType: ToolExecutor = async (input, ctx) => {
  try {
    const name = String(input.name ?? "").trim();
    if (!name) return { error: "Ticket type name is required" };

    // Check for duplicate (case-insensitive)
    const existing = await db.ticketType.findFirst({
      where: { eventId: ctx.eventId, name: { equals: name, mode: "insensitive" } },
      select: { id: true, name: true },
    });
    if (existing) {
      return {
        alreadyExists: true,
        ticketType: existing,
        message: `A ticket type named "${existing.name}" already exists for this event.`,
      };
    }

    // Get next sort order
    const maxOrder = await db.ticketType.findFirst({
      where: { eventId: ctx.eventId },
      select: { sortOrder: true },
      orderBy: { sortOrder: "desc" },
    });
    const sortOrder = (maxOrder?.sortOrder ?? -1) + 1;

    const ticketType = await db.ticketType.create({
      data: {
        eventId: ctx.eventId,
        name,
        description: input.description ? String(input.description) : null,
        isDefault: input.isDefault === true,
        isActive: true,
        sortOrder,
        pricingTiers: {
          create: [
            { name: "Early Bird", price: 0, currency: "USD", isActive: false, sortOrder: 0 },
            { name: "Standard",   price: 0, currency: "USD", isActive: false, sortOrder: 1 },
            { name: "Onsite",     price: 0, currency: "USD", isActive: false, sortOrder: 2 },
          ],
        },
      },
      select: {
        id: true,
        name: true,
        isActive: true,
        pricingTiers: { select: { id: true, name: true, price: true, isActive: true } },
      },
    });

    return {
      success: true,
      ticketType,
      message:
        "Ticket type created with 3 inactive pricing tiers (Early Bird, Standard, Onsite) at $0. Go to Settings → Registration Types to set prices and activate tiers.",
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_ticket_type failed");
    return { error: "Failed to create ticket type" };
  }
};

const createRegistration: ToolExecutor = async (input, ctx) => {
  try {
    const email = String(input.email ?? "").trim().toLowerCase();
    const firstName = String(input.firstName ?? "").trim();
    const lastName = String(input.lastName ?? "").trim();
    const ticketTypeId = String(input.ticketTypeId ?? "").trim();

    if (!email || !firstName || !lastName || !ticketTypeId) {
      return { error: "email, firstName, lastName, and ticketTypeId are all required" };
    }
    if (!EMAIL_RE.test(email)) return { error: "Invalid email format" };

    // Validate ticketTypeId belongs to this event
    const ticketType = await db.ticketType.findFirst({
      where: { id: ticketTypeId, eventId: ctx.eventId },
      select: { id: true, name: true },
    });
    if (!ticketType) return { error: "Ticket type not found for this event. Use list_ticket_types to get valid IDs." };

    // Validate pricingTierId if provided
    let validPricingTierId: string | null = null;
    if (input.pricingTierId) {
      const tier = await db.pricingTier.findFirst({
        where: { id: String(input.pricingTierId), ticketTypeId: ticketType.id },
        select: { id: true },
      });
      if (!tier) return { error: "Pricing tier not found for this ticket type." };
      validPricingTierId = tier.id;
    }

    // Validate status
    const rawStatus = input.status ? String(input.status) : "CONFIRMED";
    if (!MANUAL_REGISTRATION_STATUSES.has(rawStatus)) {
      return { error: `Invalid status "${rawStatus}". Must be one of: ${[...MANUAL_REGISTRATION_STATUSES].join(", ")}` };
    }

    // Validate title
    const rawTitle = input.title ? String(input.title) : undefined;
    if (rawTitle && !TITLE_VALUES.has(rawTitle)) {
      return { error: `Invalid title "${rawTitle}". Must be one of: ${[...TITLE_VALUES].join(", ")}` };
    }

    // Check for duplicate registration by email for this event
    const duplicate = await db.registration.findFirst({
      where: { eventId: ctx.eventId, attendee: { email } },
      select: { id: true },
    });
    if (duplicate) {
      return {
        alreadyExists: true,
        message: `A registration for ${email} already exists for this event.`,
      };
    }

    const result = await db.$transaction(async (tx) => {
      const attendee = await tx.attendee.create({
        data: {
          email,
          firstName,
          lastName,
          title: rawTitle as never ?? null,
          organization: input.organization ? String(input.organization) : null,
          jobTitle: input.jobTitle ? String(input.jobTitle) : null,
          specialty: input.specialty ? String(input.specialty) : null,
          registrationType: ticketType.name,
        },
        select: { id: true, firstName: true, lastName: true, email: true },
      });

      const serialId = await getNextSerialId(tx, ctx.eventId);
      const registration = await tx.registration.create({
        data: {
          eventId: ctx.eventId,
          ticketTypeId: ticketType.id,
          pricingTierId: validPricingTierId,
          attendeeId: attendee.id,
          serialId,
          status: rawStatus as never,
        },
        select: {
          id: true,
          status: true,
          ticketType: { select: { name: true } },
        },
      });

      return { attendee, registration };
    });

    return { success: true, ...result };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_registration failed");
    return { error: "Failed to create registration" };
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
    const rawHtmlMessage = String(input.htmlMessage ?? "").trim();
    if (!subject || !rawHtmlMessage) {
      return { error: "subject and htmlMessage are required" };
    }
    const htmlMessage = sanitizeHtml(rawHtmlMessage);

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

    if (recipients.length > MAX_EMAIL_RECIPIENTS) {
      return {
        error: `Too many recipients (${recipients.length}). Maximum is ${MAX_EMAIL_RECIPIENTS} per bulk email. Use a statusFilter to narrow the audience.`,
      };
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

// ─── Abstract Management Executors ────────────────────────────────────────────

const ABSTRACT_STATUSES = new Set(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED", "WITHDRAWN"]);
const ABSTRACT_UPDATE_STATUSES = new Set(["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"]);

const listAbstractThemes: ToolExecutor = async (_input, ctx) => {
  try {
    const themes = await db.abstractTheme.findMany({
      where: { eventId: ctx.eventId },
      select: { id: true, name: true, sortOrder: true },
      orderBy: { sortOrder: "asc" },
    });
    return { themes, total: themes.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_abstract_themes failed");
    return { error: "Failed to fetch abstract themes" };
  }
};

const createAbstractTheme: ToolExecutor = async (input, ctx) => {
  try {
    const name = String(input.name ?? "").trim();
    if (!name) return { error: "name is required" };

    const existing = await db.abstractTheme.findFirst({
      where: { eventId: ctx.eventId, name: { equals: name, mode: "insensitive" } },
    });
    if (existing) return { alreadyExists: true, theme: existing };

    const count = await db.abstractTheme.count({ where: { eventId: ctx.eventId } });
    const theme = await db.abstractTheme.create({
      data: { eventId: ctx.eventId, name, sortOrder: count },
    });
    return { theme };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_abstract_theme failed");
    return { error: "Failed to create abstract theme" };
  }
};

const listReviewCriteria: ToolExecutor = async (_input, ctx) => {
  try {
    const criteria = await db.reviewCriterion.findMany({
      where: { eventId: ctx.eventId },
      select: { id: true, name: true, weight: true, sortOrder: true },
      orderBy: { sortOrder: "asc" },
    });
    return { criteria, total: criteria.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_review_criteria failed");
    return { error: "Failed to fetch review criteria" };
  }
};

const createReviewCriterion: ToolExecutor = async (input, ctx) => {
  try {
    const name = String(input.name ?? "").trim();
    const weight = Number(input.weight ?? 1);
    if (!name) return { error: "name is required" };
    if (weight < 1 || weight > 10) return { error: "weight must be between 1 and 10" };

    const count = await db.reviewCriterion.count({ where: { eventId: ctx.eventId } });
    const criterion = await db.reviewCriterion.create({
      data: { eventId: ctx.eventId, name, weight, sortOrder: count },
    });
    return { criterion };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_review_criterion failed");
    return { error: "Failed to create review criterion" };
  }
};

const listAbstracts: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 200);
    const statusValue = input.status ? String(input.status) : undefined;
    if (statusValue && !ABSTRACT_STATUSES.has(statusValue)) {
      return { error: `Invalid status. Must be one of: ${[...ABSTRACT_STATUSES].join(", ")}` };
    }
    const abstracts = await db.abstract.findMany({
      where: {
        eventId: ctx.eventId,
        ...(statusValue ? { status: statusValue as never } : {}),
        ...(input.themeId ? { themeId: String(input.themeId) } : {}),
      },
      select: {
        id: true, title: true, status: true, specialty: true, presentationType: true,
        reviewScore: true, submittedAt: true,
        speaker: { select: { firstName: true, lastName: true, email: true } },
        theme: { select: { name: true } },
        track: { select: { name: true } },
      },
      take: limit,
      orderBy: { submittedAt: "desc" },
    });
    return { abstracts, total: abstracts.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_abstracts failed");
    return { error: "Failed to fetch abstracts" };
  }
};

const updateAbstractStatus: ToolExecutor = async (input, ctx) => {
  try {
    const abstractId = String(input.abstractId ?? "").trim();
    const status = String(input.status ?? "").trim();
    if (!abstractId) return { error: "abstractId is required" };
    if (!ABSTRACT_UPDATE_STATUSES.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...ABSTRACT_UPDATE_STATUSES].join(", ")}` };
    }

    const abstract = await db.abstract.findFirst({
      where: { id: abstractId, eventId: ctx.eventId },
      select: { id: true, title: true, status: true },
    });
    if (!abstract) return { error: `Abstract ${abstractId} not found` };

    const updated = await db.abstract.update({
      where: { id: abstractId },
      data: {
        status: status as never,
        reviewNotes: input.reviewNotes ? String(input.reviewNotes).slice(0, 2000) : undefined,
        reviewedAt: new Date(),
      },
      select: { id: true, title: true, status: true },
    });
    return { abstract: updated, previousStatus: abstract.status };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_abstract_status failed");
    return { error: "Failed to update abstract status" };
  }
};

// ─── Accommodation Executors ──────────────────────────────────────────────────

const ACCOMMODATION_STATUSES = new Set(["PENDING", "CONFIRMED", "CANCELLED", "CHECKED_IN", "CHECKED_OUT"]);

const listHotels: ToolExecutor = async (_input, ctx) => {
  try {
    const hotels = await db.hotel.findMany({
      where: { eventId: ctx.eventId },
      select: {
        id: true, name: true, address: true, stars: true, contactEmail: true, isActive: true,
        _count: { select: { roomTypes: true } },
      },
      orderBy: { name: "asc" },
    });
    return { hotels, total: hotels.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_hotels failed");
    return { error: "Failed to fetch hotels" };
  }
};

const createHotel: ToolExecutor = async (input, ctx) => {
  try {
    const name = String(input.name ?? "").trim();
    if (!name) return { error: "name is required" };

    const existing = await db.hotel.findFirst({
      where: { eventId: ctx.eventId, name: { equals: name, mode: "insensitive" } },
    });
    if (existing) return { alreadyExists: true, hotel: existing };

    const hotel = await db.hotel.create({
      data: {
        eventId: ctx.eventId,
        name,
        address: input.address ? String(input.address) : null,
        stars: input.stars ? Number(input.stars) : null,
        contactEmail: input.contactEmail ? String(input.contactEmail) : null,
        contactPhone: input.contactPhone ? String(input.contactPhone) : null,
      },
    });
    return { hotel };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_hotel failed");
    return { error: "Failed to create hotel" };
  }
};

const listAccommodations: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 200);
    const statusValue = input.status ? String(input.status) : undefined;
    if (statusValue && !ACCOMMODATION_STATUSES.has(statusValue)) {
      return { error: `Invalid status. Must be one of: ${[...ACCOMMODATION_STATUSES].join(", ")}` };
    }
    const accommodations = await db.accommodation.findMany({
      where: {
        eventId: ctx.eventId,
        ...(statusValue ? { status: statusValue as never } : {}),
      },
      select: {
        id: true, checkIn: true, checkOut: true, guestCount: true, status: true, totalPrice: true, currency: true,
        registration: { select: { attendee: { select: { firstName: true, lastName: true, email: true } } } },
        roomType: { select: { name: true, hotel: { select: { name: true } } } },
      },
      take: limit,
      orderBy: { checkIn: "asc" },
    });
    return { accommodations, total: accommodations.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_accommodations failed");
    return { error: "Failed to fetch accommodations" };
  }
};

// ─── Media Executor ───────────────────────────────────────────────────────────

const listMedia: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 100);
    const files = await db.mediaFile.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, filename: true, url: true, mimeType: true, size: true, createdAt: true },
      take: limit,
      orderBy: { createdAt: "desc" },
    });
    return { files, total: files.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_media failed");
    return { error: "Failed to fetch media files" };
  }
};

// ─── Check-in Executor ────────────────────────────────────────────────────────

const checkInRegistration: ToolExecutor = async (input, ctx) => {
  try {
    const registrationId = String(input.registrationId ?? "").trim();
    if (!registrationId) return { error: "registrationId is required" };

    const reg = await db.registration.findFirst({
      where: { id: registrationId, eventId: ctx.eventId },
      select: { id: true, status: true, checkedInAt: true, attendee: { select: { firstName: true, lastName: true } } },
    });
    if (!reg) return { error: `Registration ${registrationId} not found` };
    if (reg.checkedInAt) return { alreadyCheckedIn: true, checkedInAt: reg.checkedInAt, attendee: reg.attendee };

    await db.registration.update({
      where: { id: registrationId },
      data: { checkedInAt: new Date(), status: "CHECKED_IN" },
    });
    return { success: true, attendee: reg.attendee, checkedInAt: new Date() };
  } catch (err) {
    apiLogger.error({ err }, "agent:check_in_registration failed");
    return { error: "Failed to check in registration" };
  }
};

// ─── Contact Executors ────────────────────────────────────────────────────────

const listContacts: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 200);
    const search = input.search ? String(input.search).trim() : undefined;
    const tag = input.tag ? String(input.tag).trim() : undefined;

    const contacts = await db.contact.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(tag ? { tags: { has: tag } } : {}),
        ...(search ? {
          OR: [
            { firstName: { contains: search, mode: "insensitive" as const } },
            { lastName: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
          ],
        } : {}),
      },
      select: {
        id: true, email: true, firstName: true, lastName: true, organization: true,
        jobTitle: true, city: true, country: true, tags: true,
      },
      take: limit,
      orderBy: { lastName: "asc" },
    });
    return { contacts, total: contacts.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_contacts failed");
    return { error: "Failed to fetch contacts" };
  }
};

const createContact: ToolExecutor = async (input, ctx) => {
  try {
    const email = String(input.email ?? "").trim().toLowerCase();
    const firstName = String(input.firstName ?? "").trim();
    const lastName = String(input.lastName ?? "").trim();
    if (!email || !firstName || !lastName) return { error: "email, firstName, and lastName are required" };
    if (!EMAIL_RE.test(email)) return { error: "Invalid email format" };

    const existing = await db.contact.findFirst({
      where: { organizationId: ctx.organizationId, email },
    });
    if (existing) return { alreadyExists: true, contact: { id: existing.id, email: existing.email, firstName: existing.firstName, lastName: existing.lastName } };

    const contact = await db.contact.create({
      data: {
        organizationId: ctx.organizationId,
        email,
        firstName,
        lastName,
        organization: input.organization ? String(input.organization) : null,
        jobTitle: input.jobTitle ? String(input.jobTitle) : null,
        phone: input.phone ? String(input.phone) : null,
        city: input.city ? String(input.city) : null,
        country: input.country ? String(input.country) : null,
        tags: Array.isArray(input.tags) ? (input.tags as string[]) : [],
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    return { contact };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_contact failed");
    return { error: "Failed to create contact" };
  }
};

// ─── Reviewer Executor ────────────────────────────────────────────────────────

const listReviewers: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId },
      select: { settings: true },
    });
    const reviewerUserIds = (event?.settings as { reviewerUserIds?: string[] })?.reviewerUserIds ?? [];
    if (reviewerUserIds.length === 0) return { reviewers: [], total: 0 };

    const users = await db.user.findMany({
      where: { id: { in: reviewerUserIds } },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    return { reviewers: users, total: users.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_reviewers failed");
    return { error: "Failed to fetch reviewers" };
  }
};

// ─── Invoice Executor ─────────────────────────────────────────────────────────

const listInvoices: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 200);
    const invoices = await db.invoice.findMany({
      where: {
        eventId: ctx.eventId,
        ...(input.type ? { type: String(input.type) as never } : {}),
        ...(input.status ? { status: String(input.status) as never } : {}),
      },
      select: {
        id: true, invoiceNumber: true, type: true, status: true, total: true, currency: true,
        issueDate: true, paidDate: true,
        registration: { select: { attendee: { select: { firstName: true, lastName: true, email: true } } } },
      },
      take: limit,
      orderBy: { issueDate: "desc" },
    });
    return { invoices, total: invoices.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_invoices failed");
    return { error: "Failed to fetch invoices" };
  }
};

// ─── Email Template Executor ──────────────────────────────────────────────────

const listEmailTemplates: ToolExecutor = async (_input, ctx) => {
  try {
    const templates = await db.emailTemplate.findMany({
      where: { eventId: ctx.eventId },
      select: { id: true, name: true, subject: true, slug: true, isActive: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    return { templates, total: templates.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_email_templates failed");
    return { error: "Failed to fetch email templates" };
  }
};

// ─── Event Stats Executor ─────────────────────────────────────────────────────

const getEventStats: ToolExecutor = async (_input, ctx) => {
  try {
    const [regByStatus, regByPayment, speakersByStatus, abstractsByStatus, sessionCount, trackCount] = await Promise.all([
      db.registration.groupBy({ by: ["status"], where: { eventId: ctx.eventId }, _count: true }),
      db.registration.groupBy({ by: ["paymentStatus"], where: { eventId: ctx.eventId }, _count: true }),
      db.speaker.groupBy({ by: ["status"], where: { eventId: ctx.eventId }, _count: true }),
      db.abstract.groupBy({ by: ["status"], where: { eventId: ctx.eventId }, _count: true }),
      db.eventSession.count({ where: { eventId: ctx.eventId } }),
      db.track.count({ where: { eventId: ctx.eventId } }),
    ]);

    const checkedIn = await db.registration.count({ where: { eventId: ctx.eventId, checkedInAt: { not: null } } });

    return {
      registrations: Object.fromEntries(regByStatus.map((r) => [r.status, r._count])),
      payments: Object.fromEntries(regByPayment.map((r) => [r.paymentStatus, r._count])),
      speakers: Object.fromEntries(speakersByStatus.map((s) => [s.status, s._count])),
      abstracts: Object.fromEntries(abstractsByStatus.map((a) => [a.status, a._count])),
      sessions: sessionCount,
      tracks: trackCount,
      checkedIn,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:get_event_stats failed");
    return { error: "Failed to fetch event stats" };
  }
};

// ─── Zoom Tool Executors ──────────────────────────────────────────────────────

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
  create_ticket_type: createTicketType,
  create_registration: createRegistration,
  send_bulk_email: sendBulkEmail,
  add_topic_to_session: addTopicToSession,
  // Abstract management
  list_abstract_themes: listAbstractThemes,
  create_abstract_theme: createAbstractTheme,
  list_review_criteria: listReviewCriteria,
  create_review_criterion: createReviewCriterion,
  list_abstracts: listAbstracts,
  update_abstract_status: updateAbstractStatus,
  // Accommodation
  list_hotels: listHotels,
  create_hotel: createHotel,
  list_accommodations: listAccommodations,
  // Media
  list_media: listMedia,
  // Check-in
  check_in_registration: checkInRegistration,
  // Contacts
  list_contacts: listContacts,
  create_contact: createContact,
  // Reviewers
  list_reviewers: listReviewers,
  // Invoices
  list_invoices: listInvoices,
  // Email templates
  list_email_templates: listEmailTemplates,
  // Stats
  get_event_stats: getEventStats,
  // Zoom
  list_zoom_meetings: listZoomMeetings,
  create_zoom_meeting: createZoomMeetingTool,
};
