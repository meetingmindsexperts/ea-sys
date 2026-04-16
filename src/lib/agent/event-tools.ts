import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { checkRateLimit } from "@/lib/security";
import { apiLogger } from "@/lib/logger";
import { getNextSerialId } from "@/lib/registration-serial";
import { sanitizeHtml } from "@/lib/sanitize";
import { notifyAbstractStatusChange } from "@/lib/abstract-notifications";
import { slugify, normalizeTag } from "@/lib/utils";
import { provisionWebinar } from "@/lib/webinar-provisioner";
import { readWebinarSettings, readSponsors, SPONSOR_TIERS, type SponsorEntry } from "@/lib/webinar";
import { DEFAULT_REGISTRATION_TERMS_HTML, DEFAULT_SPEAKER_AGREEMENT_HTML } from "@/lib/default-terms";
import { syncToContact } from "@/lib/contact-sync";
import {
  computeSubmissionAggregates,
  consolidateReviewNotes,
  readRequiredReviewCount,
  computeWeightedOverallScore,
  type CriterionScore,
} from "@/lib/abstract-review";

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

    // Explicit pre-check so we can return the existing speaker's id. This lets
    // callers (like Claude) auto-pivot to update_speaker instead of needing a
    // second list_speakers call to find the existing row. The P2002 catch below
    // remains as a safety net for race conditions between this check and create.
    const existing = await db.speaker.findFirst({
      where: { eventId: ctx.eventId, email },
      select: { id: true },
    });
    if (existing) {
      return {
        error: `A speaker with email ${email} already exists for this event`,
        existingId: existing.id,
        suggestion: "Use update_speaker with speakerId to modify this speaker, or use a different email",
      };
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

    // Check for duplicate registration by email for this event.
    // Returns existingRegistrationId so callers can auto-pivot to update_registration.
    const duplicate = await db.registration.findFirst({
      where: { eventId: ctx.eventId, attendee: { email } },
      select: { id: true },
    });
    if (duplicate) {
      return {
        alreadyExists: true,
        existingRegistrationId: duplicate.id,
        message: `A registration for ${email} already exists for this event.`,
        suggestion: "Use update_registration with registrationId to modify this registration",
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
        submittedAt: true,
        speaker: { select: { firstName: true, lastName: true, email: true } },
        theme: { select: { name: true } },
        track: { select: { name: true } },
        submissions: {
          select: { overallScore: true },
        },
      },
      take: limit,
      orderBy: { submittedAt: "desc" },
    });
    // Fold a lightweight aggregate onto each row so the list UI + Claude
    // don't have to make a second call just to show scores.
    const enriched = abstracts.map((a) => {
      const overalls = a.submissions
        .map((s) => s.overallScore)
        .filter((s): s is number => s != null);
      const meanOverall = overalls.length
        ? Math.round((overalls.reduce((x, y) => x + y, 0) / overalls.length) * 10) / 10
        : null;
      // Strip the submissions array — agent callers only want the rollup.
      const rest: Omit<typeof a, "submissions"> & { submissions?: typeof a.submissions } = { ...a };
      delete rest.submissions;
      return {
        ...rest,
        reviewCount: a.submissions.length,
        meanOverallScore: meanOverall,
      };
    });
    return { abstracts: enriched, total: enriched.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_abstracts failed");
    return { error: "Failed to fetch abstracts" };
  }
};

const updateAbstractStatus: ToolExecutor = async (input, ctx) => {
  try {
    const abstractId = String(input.abstractId ?? "").trim();
    const status = String(input.status ?? "").trim();
    const force = input.force === true;
    if (!abstractId) return { error: "abstractId is required", code: "MISSING_ABSTRACT_ID" };
    if (!ABSTRACT_UPDATE_STATUSES.has(status)) {
      return {
        error: `Invalid status. Must be one of: ${[...ABSTRACT_UPDATE_STATUSES].join(", ")}`,
        code: "INVALID_STATUS",
      };
    }

    const abstract = await db.abstract.findFirst({
      where: { id: abstractId, eventId: ctx.eventId },
      select: {
        id: true,
        title: true,
        status: true,
        event: { select: { id: true, name: true, slug: true, settings: true } },
        speaker: { select: { email: true, firstName: true, lastName: true } },
      },
    });
    if (!abstract) return { error: `Abstract ${abstractId} not found`, code: "ABSTRACT_NOT_FOUND" };

    // Terminal-state guard: WITHDRAWN is the only truly terminal status.
    // ACCEPTED ↔ REJECTED transitions are allowed (organizer may change mind).
    if (abstract.status === "WITHDRAWN") {
      return {
        error: "Cannot update a withdrawn abstract",
        code: "ABSTRACT_WITHDRAWN",
        currentStatus: abstract.status,
        suggestion: "Withdrawn abstracts are terminal. The submitter must resubmit a new abstract.",
      };
    }

    // Gate ACCEPTED / REJECTED transitions on sufficient review submissions.
    // The requiredReviewCount setting defaults to 1. `force: true` bypasses
    // the gate and is logged as a chair override.
    const aggregate = await computeSubmissionAggregates(abstractId);
    const requiredCount = readRequiredReviewCount(abstract.event.settings);
    const gateRelevant = status === "ACCEPTED" || status === "REJECTED";
    if (gateRelevant && !force && aggregate.aggregates.count < requiredCount) {
      apiLogger.warn(
        { abstractId, currentCount: aggregate.aggregates.count, required: requiredCount },
        "abstract-status:insufficient-reviews",
      );
      return {
        error: `This event requires ${requiredCount} review submission(s) before ${status}. Current: ${aggregate.aggregates.count}.`,
        code: "INSUFFICIENT_REVIEWS",
        currentCount: aggregate.aggregates.count,
        required: requiredCount,
        suggestion: "Assign + collect more reviews, or pass force=true to override (logged as chair override).",
      };
    }

    const previousStatus = abstract.status;

    // DB update is the authoritative state change — succeed or fail loudly here.
    const updated = await db.abstract.update({
      where: { id: abstractId },
      data: {
        status: status as never,
        reviewedAt: new Date(),
      },
      select: { id: true, title: true, status: true },
    });

    apiLogger.info(
      { abstractId, previousStatus, newStatus: status, force, reviewCount: aggregate.aggregates.count },
      "abstract-status:changed",
    );

    await db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "REVIEW",
        entityType: "Abstract",
        entityId: abstract.id,
        changes: {
          before: { status: previousStatus },
          after: { status },
          source: force ? "chair-override" : "mcp",
          reviewCount: aggregate.aggregates.count,
          meanOverall: aggregate.aggregates.meanOverall,
        },
      },
    }).catch((err) =>
      apiLogger.error({ err, abstractId }, "agent:update_abstract_status audit-log-failed"),
    );

    // Aggregate consolidated notes from all reviewers for the speaker email.
    const consolidatedNotes = consolidateReviewNotes(aggregate.submissions);

    // Notification is isolated: a failing email send must not mask the
    // successful DB update. Surface notificationStatus in the return payload
    // so callers (Claude, dashboards) know whether to follow up manually.
    let notificationStatus: "sent" | "failed" = "sent";
    let notificationError: string | undefined;
    try {
      await notifyAbstractStatusChange({
        eventId: ctx.eventId,
        eventName: abstract.event.name,
        eventSlug: abstract.event.slug,
        abstractId: abstract.id,
        abstractTitle: abstract.title,
        previousStatus,
        newStatus: status,
        reviewNotes: consolidatedNotes,
        reviewScore: aggregate.aggregates.meanOverall,
        speaker: {
          email: abstract.speaker?.email ?? null,
          firstName: abstract.speaker?.firstName ?? "",
          lastName: abstract.speaker?.lastName ?? "",
        },
      });
    } catch (notifyErr) {
      apiLogger.error(
        { err: notifyErr, abstractId },
        "abstract-status:notification-failed",
      );
      notificationStatus = "failed";
      notificationError = notifyErr instanceof Error ? notifyErr.message : "Unknown notification error";
    }

    return {
      abstract: updated,
      previousStatus,
      reviewCount: aggregate.aggregates.count,
      meanOverallScore: aggregate.aggregates.meanOverall,
      forcedOverride: force,
      notificationStatus,
      ...(notificationError && { notificationError }),
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_abstract_status failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      error: "Failed to update abstract status",
      code: "UNKNOWN",
      details: message,
    };
  }
};

// ─── Sprint B: Reviewer assignment + per-reviewer submissions ─────────────────

const ABSTRACT_REVIEWER_ROLES = new Set(["PRIMARY", "SECONDARY", "CONSULTING"]);
const RECOMMENDED_FORMATS = new Set(["ORAL", "POSTER", "NEITHER"]);

/**
 * Load the event's reviewer pool + review criteria together so
 * `submit_abstract_review` can (a) check the user is a reviewer and (b)
 * auto-compute overallScore from criteriaScores using the same weight
 * calculation as the REST route.
 */
async function loadReviewerGuardAndCriteria(eventId: string) {
  return db.event.findFirst({
    where: { id: eventId },
    select: {
      settings: true,
      reviewCriteria: { select: { id: true, weight: true } },
    },
  });
}

const assignReviewerToAbstract: ToolExecutor = async (input, ctx) => {
  try {
    const abstractId = String(input.abstractId ?? "").trim();
    const userId = String(input.userId ?? "").trim();
    const role = input.role ? String(input.role) : "SECONDARY";
    if (!abstractId) return { error: "abstractId is required", code: "MISSING_ABSTRACT_ID" };
    if (!userId) return { error: "userId is required", code: "MISSING_USER_ID" };
    if (!ABSTRACT_REVIEWER_ROLES.has(role)) {
      return {
        error: `Invalid role. Must be one of: ${[...ABSTRACT_REVIEWER_ROLES].join(", ")}`,
        code: "INVALID_ROLE",
      };
    }

    const [abstract, user] = await Promise.all([
      db.abstract.findFirst({
        where: { id: abstractId, eventId: ctx.eventId },
        select: { id: true, event: { select: { id: true, settings: true } } },
      }),
      db.user.findUnique({ where: { id: userId }, select: { id: true, firstName: true, lastName: true, email: true } }),
    ]);
    if (!abstract) return { error: `Abstract ${abstractId} not found`, code: "ABSTRACT_NOT_FOUND" };
    if (!user) return { error: `User ${userId} not found`, code: "USER_NOT_FOUND" };

    const existing = await db.abstractReviewer.findUnique({
      where: { abstractId_userId: { abstractId, userId } },
      select: { id: true, role: true },
    });
    if (existing) {
      return {
        alreadyAssigned: true,
        existingAssignmentId: existing.id,
        currentRole: existing.role,
        message: `${user.firstName} ${user.lastName} is already assigned to this abstract as ${existing.role}`,
      };
    }

    const assignment = await db.abstractReviewer.create({
      data: {
        abstractId,
        userId,
        assignedById: ctx.userId,
        role: role as never,
      },
      select: { id: true, role: true, assignedAt: true },
    });

    apiLogger.info({ abstractId, userId, role }, "abstract-reviewer:assigned");

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "ASSIGN",
        entityType: "AbstractReviewer",
        entityId: assignment.id,
        changes: { source: "mcp", abstractId, reviewerUserId: userId, role },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:assign_reviewer_to_abstract audit-log-failed"));

    return {
      success: true,
      assignment: {
        ...assignment,
        reviewer: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email },
      },
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:assign_reviewer_to_abstract failed");
    return {
      error: "Failed to assign reviewer",
      code: "UNKNOWN",
      details: err instanceof Error ? err.message : "Unknown error",
    };
  }
};

const unassignReviewerFromAbstract: ToolExecutor = async (input, ctx) => {
  try {
    const abstractId = String(input.abstractId ?? "").trim();
    const userId = String(input.userId ?? "").trim();
    if (!abstractId) return { error: "abstractId is required", code: "MISSING_ABSTRACT_ID" };
    if (!userId) return { error: "userId is required", code: "MISSING_USER_ID" };

    // Verify abstract belongs to this org scope
    const abstract = await db.abstract.findFirst({
      where: { id: abstractId, eventId: ctx.eventId },
      select: { id: true },
    });
    if (!abstract) return { error: `Abstract ${abstractId} not found`, code: "ABSTRACT_NOT_FOUND" };

    const assignment = await db.abstractReviewer.findUnique({
      where: { abstractId_userId: { abstractId, userId } },
      select: { id: true },
    });
    if (!assignment) {
      return {
        error: `No assignment found for user ${userId} on abstract ${abstractId}`,
        code: "ASSIGNMENT_NOT_FOUND",
      };
    }

    // Deletes the AbstractReviewer row. Any existing AbstractReviewSubmission
    // from this user gets `abstractReviewerId` nulled via SET NULL FK — the
    // submission itself is preserved (it has independent value).
    await db.abstractReviewer.delete({ where: { id: assignment.id } });

    apiLogger.info({ abstractId, userId }, "abstract-reviewer:unassigned");

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "UNASSIGN",
        entityType: "AbstractReviewer",
        entityId: assignment.id,
        changes: { source: "mcp", abstractId, reviewerUserId: userId },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:unassign_reviewer_from_abstract audit-log-failed"));

    return {
      success: true,
      unassignedAssignmentId: assignment.id,
      note: "Assignment removed. Any submission this reviewer made is preserved.",
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:unassign_reviewer_from_abstract failed");
    return {
      error: "Failed to unassign reviewer",
      code: "UNKNOWN",
      details: err instanceof Error ? err.message : "Unknown error",
    };
  }
};

const submitAbstractReview: ToolExecutor = async (input, ctx) => {
  try {
    const abstractId = String(input.abstractId ?? "").trim();
    if (!abstractId) return { error: "abstractId is required", code: "MISSING_ABSTRACT_ID" };

    // API-key / OAuth callers (ctx.userId = SYSTEM_USER_ID "mcp-remote") don't
    // have a real user identity, so they can't be "the reviewer who scored
    // this abstract" — the submission would get attributed to a sentinel.
    // Reject early with a clear error; if you need bulk review ingestion
    // from external systems, the right shape is a separate org-admin-only
    // tool that takes an explicit reviewerUserId. For now, require a real
    // user session (OAuth with per-user grant, or dashboard/in-app agent).
    if (ctx.userId === "mcp-remote") {
      return {
        error:
          "submit_abstract_review requires an authenticated user session. " +
          "It cannot be called via API-key MCP (no user identity to attribute the review to). " +
          "Use the dashboard's /my-reviews portal, the in-app AI agent, or OAuth-based MCP with a per-user grant.",
        code: "MCP_API_KEY_NOT_SUPPORTED",
      };
    }

    // Abstract must exist + belong to this org scope
    const abstract = await db.abstract.findFirst({
      where: { id: abstractId, eventId: ctx.eventId },
      select: { id: true },
    });
    if (!abstract) return { error: `Abstract ${abstractId} not found`, code: "ABSTRACT_NOT_FOUND" };

    // Reviewer auth: the submitting user (ctx.userId) must be EITHER in the
    // event's reviewer pool OR have an explicit AbstractReviewer row.
    const [eventData, existingAssignment] = await Promise.all([
      loadReviewerGuardAndCriteria(ctx.eventId),
      db.abstractReviewer.findUnique({
        where: { abstractId_userId: { abstractId, userId: ctx.userId } },
        select: { id: true },
      }),
    ]);
    const reviewerUserIds = (eventData?.settings as { reviewerUserIds?: string[] } | null)?.reviewerUserIds ?? [];
    const isEventReviewer = reviewerUserIds.includes(ctx.userId);
    if (!isEventReviewer && !existingAssignment) {
      return {
        error: `User ${ctx.userId} is not a reviewer for this event. Assign them to the abstract or add to event.settings.reviewerUserIds first.`,
        code: "NOT_A_REVIEWER",
      };
    }

    // Parse + validate inputs
    const overallScoreInput = input.overallScore != null ? Number(input.overallScore) : undefined;
    if (overallScoreInput !== undefined && (overallScoreInput < 0 || overallScoreInput > 100)) {
      return { error: "overallScore must be between 0 and 100", code: "INVALID_OVERALL_SCORE" };
    }

    const confidence = input.confidence != null ? Number(input.confidence) : undefined;
    if (confidence !== undefined && (confidence < 1 || confidence > 5)) {
      return { error: "confidence must be between 1 and 5", code: "INVALID_CONFIDENCE" };
    }

    const recommendedFormat = input.recommendedFormat ? String(input.recommendedFormat) : undefined;
    if (recommendedFormat && !RECOMMENDED_FORMATS.has(recommendedFormat)) {
      return {
        error: `Invalid recommendedFormat. Must be one of: ${[...RECOMMENDED_FORMATS].join(", ")}`,
        code: "INVALID_RECOMMENDED_FORMAT",
      };
    }

    const reviewNotes = input.reviewNotes ? String(input.reviewNotes).slice(0, 5000) : null;

    const criteriaScoresInput = input.criteriaScores && typeof input.criteriaScores === "object"
      ? (input.criteriaScores as Record<string, unknown>)
      : null;

    // Validate criteria IDs against the event's criteria so callers can't
    // submit scores for criteria that don't exist here.
    let criteriaScoresJson: Record<string, number> | null = null;
    let computedOverall: number | null = null;
    if (criteriaScoresInput) {
      const validIds = new Set((eventData?.reviewCriteria ?? []).map((c) => c.id));
      const weightMap = new Map((eventData?.reviewCriteria ?? []).map((c) => [c.id, c.weight]));
      const cleaned: Record<string, number> = {};
      for (const [id, raw] of Object.entries(criteriaScoresInput)) {
        if (!validIds.has(id)) {
          return { error: `Unknown criterion ID: ${id}`, code: "INVALID_CRITERION_ID" };
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 10) {
          return { error: `Score for criterion ${id} must be 0-10`, code: "INVALID_CRITERION_SCORE" };
        }
        cleaned[id] = n;
      }
      criteriaScoresJson = cleaned;
      // Auto-compute overallScore if the caller didn't set one explicitly
      if (overallScoreInput === undefined) {
        const items: CriterionScore[] = Object.entries(cleaned).map(([critId, score]) => ({
          criterionId: critId,
          score,
          weight: weightMap.get(critId) ?? 0,
        }));
        computedOverall = computeWeightedOverallScore(items);
      }
    }
    const overallScore = overallScoreInput ?? computedOverall;

    // Upsert on (abstractId, reviewerUserId). Link to the AbstractReviewer row
    // if one exists; otherwise leave abstractReviewerId null.
    const submission = await db.abstractReviewSubmission.upsert({
      where: { abstractId_reviewerUserId: { abstractId, reviewerUserId: ctx.userId } },
      create: {
        abstractId,
        reviewerUserId: ctx.userId,
        abstractReviewerId: existingAssignment?.id ?? null,
        criteriaScores: criteriaScoresJson ?? undefined,
        overallScore,
        reviewNotes,
        recommendedFormat: (recommendedFormat as never) ?? null,
        confidence: confidence ?? null,
      },
      update: {
        ...(criteriaScoresJson && { criteriaScores: criteriaScoresJson }),
        ...(overallScore !== null && overallScore !== undefined && { overallScore }),
        ...(reviewNotes !== null && { reviewNotes }),
        ...(recommendedFormat && { recommendedFormat: recommendedFormat as never }),
        ...(confidence !== undefined && { confidence }),
        // Re-link to the current assignment on every write so unassign/
        // re-assign cycles don't leave a stale (null) FK.
        abstractReviewerId: existingAssignment?.id ?? null,
      },
      select: {
        id: true,
        overallScore: true,
        reviewNotes: true,
        recommendedFormat: true,
        confidence: true,
        submittedAt: true,
        updatedAt: true,
      },
    });

    const wasCreate = submission.submittedAt.getTime() === submission.updatedAt.getTime();
    apiLogger.info(
      { abstractId, reviewerUserId: ctx.userId, overallScore },
      wasCreate ? "abstract-submission:created" : "abstract-submission:updated",
    );

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: wasCreate ? "CREATE" : "UPDATE",
        entityType: "AbstractReviewSubmission",
        entityId: submission.id,
        changes: { source: "mcp", abstractId, overallScore, hasCriteriaScores: !!criteriaScoresJson },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:submit_abstract_review audit-log-failed"));

    return { success: true, submission };
  } catch (err) {
    apiLogger.error({ err }, "agent:submit_abstract_review failed");
    return {
      error: "Failed to submit review",
      code: "UNKNOWN",
      details: err instanceof Error ? err.message : "Unknown error",
    };
  }
};

const getAbstractScores: ToolExecutor = async (input, ctx) => {
  try {
    const abstractId = String(input.abstractId ?? "").trim();
    if (!abstractId) return { error: "abstractId is required", code: "MISSING_ABSTRACT_ID" };

    const abstract = await db.abstract.findFirst({
      where: { id: abstractId, eventId: ctx.eventId },
      select: {
        id: true,
        title: true,
        status: true,
        event: { select: { settings: true } },
        reviewers: {
          select: {
            id: true,
            role: true,
            assignedAt: true,
            user: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        },
      },
    });
    if (!abstract) return { error: `Abstract ${abstractId} not found`, code: "ABSTRACT_NOT_FOUND" };

    const aggregate = await computeSubmissionAggregates(abstractId);
    const requiredCount = readRequiredReviewCount(abstract.event.settings);

    return {
      abstract: { id: abstract.id, title: abstract.title, status: abstract.status },
      assignedReviewers: abstract.reviewers.map((r) => ({
        assignmentId: r.id,
        role: r.role,
        assignedAt: r.assignedAt,
        user: r.user,
      })),
      submissions: aggregate.submissions,
      aggregates: aggregate.aggregates,
      requiredReviewCount: requiredCount,
      meetsThreshold: aggregate.aggregates.count >= requiredCount,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:get_abstract_scores failed");
    return { error: "Failed to fetch abstract scores", code: "UNKNOWN" };
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
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    if (existing) {
      return {
        alreadyExists: true,
        existingId: existing.id,
        contact: existing,
        message: `A contact with email ${email} already exists in this organization`,
      };
    }

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

// ═══════════════════════════════════════════════════════════════════════════════
// MCP Expansion (April 2026) — 22 new tools across 4 tranches
// ═══════════════════════════════════════════════════════════════════════════════
// Tranche 0: create_event (the obvious missing CRUD tool)
// Tranche A: orchestration reads (5) — composite answers for common questions
// Tranche B: actions (4) — plug the read/write asymmetry with update tools
// Tranche C: recently shipped features (12) — webinar + sponsors + agreement
//                                              template + promo codes + scheduled
// ═══════════════════════════════════════════════════════════════════════════════

const EVENT_TYPES = new Set(["CONFERENCE", "WEBINAR", "HYBRID"]);
const EVENT_STATUSES = new Set(["DRAFT", "PUBLISHED", "LIVE", "COMPLETED", "CANCELLED"]);
const SESSION_STATUSES = new Set(["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"]);
const ALL_PAYMENT_STATUSES = new Set(["UNPAID", "PENDING", "PAID", "COMPLIMENTARY", "REFUNDED", "FAILED"]);
const UNPAID_STATUSES = ["UNPAID", "PENDING", "FAILED"];
const DISCOUNT_TYPES = new Set(["PERCENTAGE", "FIXED_AMOUNT"]);

// ─── Tranche 0: create_event ──────────────────────────────────────────────────

const createEvent: ToolExecutor = async (input, ctx) => {
  try {
    const name = String(input.name ?? "").trim();
    const startDateStr = String(input.startDate ?? "").trim();
    const endDateStr = String(input.endDate ?? "").trim();
    if (!name) return { error: "name is required" };
    if (name.length < 2 || name.length > 255) return { error: "name must be 2-255 chars" };
    if (!startDateStr || !endDateStr) return { error: "startDate and endDate are required (ISO 8601)" };

    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);
    if (isNaN(startDate.getTime())) return { error: "startDate is not a valid ISO 8601 date" };
    if (isNaN(endDate.getTime())) return { error: "endDate is not a valid ISO 8601 date" };
    if (endDate < startDate) return { error: "endDate must be on or after startDate" };

    const eventType = input.eventType ? String(input.eventType) : undefined;
    if (eventType && !EVENT_TYPES.has(eventType)) {
      return { error: `Invalid eventType. Must be one of: ${[...EVENT_TYPES].join(", ")}` };
    }
    const status = input.status ? String(input.status) : undefined;
    if (status && !EVENT_STATUSES.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...EVENT_STATUSES].join(", ")}` };
    }

    // Slug generation: start from requested (or slugified name), then retry with
    // -1, -2, ... up to 10 times if collides within this org. Fail loudly rather
    // than silently creating a duplicate (which was the old POST-route behavior
    // of appending Date.now() — confusing for humans).
    const requestedSlug = input.slug ? slugify(String(input.slug)) : slugify(name);
    if (!requestedSlug) return { error: "Could not generate a valid slug from name" };

    let slug = requestedSlug;
    for (let i = 0; i < 11; i++) {
      const existing = await db.event.findFirst({
        where: { organizationId: ctx.organizationId, slug },
        select: { id: true },
      });
      if (!existing) break;
      if (i === 10) {
        return { error: `Slug "${requestedSlug}" is taken; tried 10 suffixes. Pass an explicit slug.` };
      }
      slug = `${requestedSlug}-${i + 1}`;
    }

    const event = await db.event.create({
      data: {
        organizationId: ctx.organizationId,
        name,
        slug,
        description: input.description ? String(input.description).slice(0, 2000) : null,
        startDate,
        endDate,
        timezone: input.timezone ? String(input.timezone) : "Asia/Dubai",
        venue: input.venue ? String(input.venue).slice(0, 255) : null,
        address: input.address ? String(input.address).slice(0, 500) : null,
        city: input.city ? String(input.city).slice(0, 255) : null,
        country: input.country ? String(input.country).slice(0, 255) : null,
        eventType: (eventType as never) ?? null,
        tag: input.tag ? String(input.tag).slice(0, 255) : null,
        specialty: input.specialty ? String(input.specialty).slice(0, 255) : null,
        status: (status as never) ?? "DRAFT",
        registrationTermsHtml: DEFAULT_REGISTRATION_TERMS_HTML,
        speakerAgreementHtml: DEFAULT_SPEAKER_AGREEMENT_HTML,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        eventType: true,
        startDate: true,
        endDate: true,
        timezone: true,
        venue: true,
      },
    });

    await db.auditLog.create({
      data: {
        eventId: event.id,
        userId: ctx.userId,
        action: "CREATE",
        entityType: "Event",
        entityId: event.id,
        changes: { source: "mcp", name: event.name, slug: event.slug, eventType: event.eventType ?? null },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:create_event audit-log-failed"));

    // Fire-and-forget WEBINAR auto-provisioning (anchor session + Zoom + email sequence)
    if (event.eventType === "WEBINAR") {
      provisionWebinar(event.id, { actorUserId: ctx.userId }).catch((err) =>
        apiLogger.error({ err, eventId: event.id }, "agent:create_event webinar-provision-failed"),
      );
    }

    return { success: true, event };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_event failed");
    return { error: "Failed to create event" };
  }
};

// ─── Tranche A: Orchestration reads ───────────────────────────────────────────

const getEventDashboard: ToolExecutor = async (_input, ctx) => {
  try {
    const now = new Date();
    const [
      event,
      regByStatus,
      regByPayment,
      speakerByStatus,
      sessionCount,
      upcomingSessionCount,
      liveSessionCount,
      pastSessionCount,
      totalSpeakers,
      agreementsSigned,
      checkedInCount,
      totalConfirmed,
      recentRegistrations,
      nextSession,
    ] = await Promise.all([
      db.event.findFirst({
        where: { id: ctx.eventId, organizationId: ctx.organizationId },
        select: { id: true, name: true, slug: true, status: true, eventType: true, startDate: true, endDate: true, timezone: true },
      }),
      db.registration.groupBy({ by: ["status"], where: { eventId: ctx.eventId }, _count: true }),
      db.registration.groupBy({ by: ["paymentStatus"], where: { eventId: ctx.eventId }, _count: true }),
      db.speaker.groupBy({ by: ["status"], where: { eventId: ctx.eventId }, _count: true }),
      db.eventSession.count({ where: { eventId: ctx.eventId } }),
      db.eventSession.count({ where: { eventId: ctx.eventId, startTime: { gt: now } } }),
      db.eventSession.count({ where: { eventId: ctx.eventId, startTime: { lte: now }, endTime: { gte: now } } }),
      db.eventSession.count({ where: { eventId: ctx.eventId, endTime: { lt: now } } }),
      db.speaker.count({ where: { eventId: ctx.eventId } }),
      db.speaker.count({ where: { eventId: ctx.eventId, agreementAcceptedAt: { not: null } } }),
      db.registration.count({ where: { eventId: ctx.eventId, status: "CHECKED_IN" } }),
      db.registration.count({ where: { eventId: ctx.eventId, status: { in: ["CONFIRMED", "CHECKED_IN"] } } }),
      db.registration.findMany({
        where: { eventId: ctx.eventId },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          status: true,
          paymentStatus: true,
          createdAt: true,
          attendee: { select: { firstName: true, lastName: true, email: true } },
          ticketType: { select: { name: true } },
        },
      }),
      db.eventSession.findFirst({
        where: { eventId: ctx.eventId, startTime: { gt: now } },
        orderBy: { startTime: "asc" },
        select: { id: true, name: true, startTime: true, endTime: true, location: true },
      }),
    ]);

    if (!event) return { error: "Event not found or access denied" };

    const totalRegistrations = regByStatus.reduce((s, r) => s + r._count, 0);
    return {
      event,
      registrations: {
        total: totalRegistrations,
        byStatus: Object.fromEntries(regByStatus.map(r => [r.status, r._count])),
        byPayment: Object.fromEntries(regByPayment.map(r => [r.paymentStatus, r._count])),
        checkInRate: totalConfirmed === 0 ? 0 : Math.round((checkedInCount / totalConfirmed) * 100),
      },
      speakers: {
        total: totalSpeakers,
        byStatus: Object.fromEntries(speakerByStatus.map(r => [r.status, r._count])),
        agreementsSigned,
        agreementsUnsigned: totalSpeakers - agreementsSigned,
      },
      sessions: {
        total: sessionCount,
        upcoming: upcomingSessionCount,
        liveNow: liveSessionCount,
        past: pastSessionCount,
      },
      recentRegistrations,
      nextSession,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:get_event_dashboard failed");
    return { error: "Failed to build event dashboard" };
  }
};

const listUnpaidRegistrations: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 100), 500);
    const daysPending = input.daysPending != null ? Number(input.daysPending) : null;
    const ageCutoff = daysPending != null && daysPending > 0
      ? new Date(Date.now() - daysPending * 24 * 60 * 60 * 1000)
      : null;

    const registrations = await db.registration.findMany({
      where: {
        eventId: ctx.eventId,
        paymentStatus: { in: UNPAID_STATUSES as never[] },
        status: { not: "CANCELLED" },
        ...(ageCutoff ? { createdAt: { lte: ageCutoff } } : {}),
      },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        createdAt: true,
        serialId: true,
        attendee: { select: { firstName: true, lastName: true, email: true, organization: true } },
        ticketType: { select: { name: true } },
      },
      take: limit,
      orderBy: { createdAt: "asc" }, // Oldest first
    });

    const now = Date.now();
    const enriched = registrations.map((r) => ({
      ...r,
      daysSinceRegistration: Math.floor((now - r.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
    }));

    return { registrations: enriched, total: registrations.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_unpaid_registrations failed");
    return { error: "Failed to list unpaid registrations" };
  }
};

const listSpeakerAgreements: ToolExecutor = async (input, ctx) => {
  try {
    const filter = input.filter ? String(input.filter) : "unsigned";
    if (!["signed", "unsigned", "all"].includes(filter)) {
      return { error: `Invalid filter. Must be: signed, unsigned, or all` };
    }
    const limit = Math.min(Number(input.limit ?? 100), 500);

    const where: Prisma.SpeakerWhereInput = {
      eventId: ctx.eventId,
      status: { not: "CANCELLED" },
    };
    if (filter === "signed") where.agreementAcceptedAt = { not: null };
    if (filter === "unsigned") where.agreementAcceptedAt = null;

    const speakers = await db.speaker.findMany({
      where,
      select: {
        id: true,
        title: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
        organization: true,
        agreementAcceptedAt: true,
      },
      take: limit,
      orderBy: [{ agreementAcceptedAt: { sort: "asc", nulls: "first" } }, { lastName: "asc" }],
    });

    return { filter, speakers, total: speakers.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_speaker_agreements failed");
    return { error: "Failed to list speaker agreements" };
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

const searchEvent: ToolExecutor = async (input, ctx) => {
  try {
    const query = String(input.query ?? "").trim();
    if (!query || query.length < 2) return { error: "query must be at least 2 characters" };
    const limit = Math.min(Number(input.limit ?? 20), 100);

    const requestedDomains = Array.isArray(input.domains)
      ? (input.domains as unknown[]).map((d) => String(d))
      : ["registrations", "speakers", "abstracts", "contacts"];
    const domains = new Set(requestedDomains.filter((d) =>
      ["registrations", "speakers", "abstracts", "contacts"].includes(d)));

    const ci = { contains: query, mode: "insensitive" as const };

    const [registrations, speakers, abstracts, contacts] = await Promise.all([
      domains.has("registrations")
        ? db.registration.findMany({
            where: {
              eventId: ctx.eventId,
              OR: [
                { attendee: { firstName: ci } },
                { attendee: { lastName: ci } },
                { attendee: { email: ci } },
                { attendee: { organization: ci } },
                { attendee: { tags: { has: query } } },
              ],
            },
            select: {
              id: true,
              status: true,
              attendee: { select: { firstName: true, lastName: true, email: true, organization: true } },
            },
            take: limit,
          })
        : Promise.resolve([]),
      domains.has("speakers")
        ? db.speaker.findMany({
            where: {
              eventId: ctx.eventId,
              OR: [
                { firstName: ci },
                { lastName: ci },
                { email: ci },
                { organization: ci },
              ],
            },
            select: { id: true, firstName: true, lastName: true, email: true, organization: true, status: true },
            take: limit,
          })
        : Promise.resolve([]),
      domains.has("abstracts")
        ? db.abstract.findMany({
            where: {
              eventId: ctx.eventId,
              OR: [
                { title: ci },
                { speaker: { firstName: ci } },
                { speaker: { lastName: ci } },
              ],
            },
            select: {
              id: true,
              title: true,
              status: true,
              speaker: { select: { firstName: true, lastName: true, email: true } },
            },
            take: limit,
          })
        : Promise.resolve([]),
      domains.has("contacts")
        ? db.contact.findMany({
            where: {
              organizationId: ctx.organizationId,
              eventIds: { has: ctx.eventId },
              OR: [
                { firstName: ci },
                { lastName: ci },
                { email: ci },
                { organization: ci },
              ],
            },
            select: { id: true, firstName: true, lastName: true, email: true, organization: true },
            take: limit,
          })
        : Promise.resolve([]),
    ]);

    return {
      query,
      results: {
        registrations: registrations.map((r) => ({
          domain: "registration" as const,
          id: r.id,
          label: `${r.attendee.firstName} ${r.attendee.lastName} <${r.attendee.email}>`,
          status: r.status,
          organization: r.attendee.organization,
        })),
        speakers: speakers.map((s) => ({
          domain: "speaker" as const,
          id: s.id,
          label: `${s.firstName} ${s.lastName} <${s.email}>`,
          status: s.status,
          organization: s.organization,
        })),
        abstracts: abstracts.map((a) => ({
          domain: "abstract" as const,
          id: a.id,
          label: a.title,
          status: a.status,
          author: `${a.speaker.firstName} ${a.speaker.lastName}`,
        })),
        contacts: contacts.map((c) => ({
          domain: "contact" as const,
          id: c.id,
          label: `${c.firstName} ${c.lastName} <${c.email}>`,
          organization: c.organization,
        })),
      },
      totalFound: registrations.length + speakers.length + abstracts.length + contacts.length,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:search_event failed");
    return { error: "Failed to search event" };
  }
};

// ─── Tranche B: Action / update tools ─────────────────────────────────────────

const updateRegistration: ToolExecutor = async (input, ctx) => {
  try {
    const registrationId = String(input.registrationId ?? "").trim();
    if (!registrationId) return { error: "registrationId is required" };

    // Verify the registration belongs to the authenticated org's event
    const existing = await db.registration.findFirst({
      where: { id: registrationId, event: { organizationId: ctx.organizationId } },
      select: {
        id: true,
        eventId: true,
        status: true,
        paymentStatus: true,
        ticketTypeId: true,
        attendeeId: true,
        attendee: { select: { id: true, firstName: true, lastName: true, email: true, tags: true } },
      },
    });
    if (!existing) return { error: `Registration ${registrationId} not found or access denied` };

    const status = input.status ? String(input.status) : undefined;
    if (status && !REGISTRATION_STATUSES.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...REGISTRATION_STATUSES].join(", ")}` };
    }
    const paymentStatus = input.paymentStatus ? String(input.paymentStatus) : undefined;
    if (paymentStatus && !ALL_PAYMENT_STATUSES.has(paymentStatus)) {
      return { error: `Invalid paymentStatus. Must be one of: ${[...ALL_PAYMENT_STATUSES].join(", ")}` };
    }

    const newTicketTypeId = input.ticketTypeId ? String(input.ticketTypeId) : undefined;
    if (newTicketTypeId && newTicketTypeId !== existing.ticketTypeId) {
      const ticket = await db.ticketType.findFirst({
        where: { id: newTicketTypeId, eventId: existing.eventId },
        select: { id: true },
      });
      if (!ticket) return { error: `ticketTypeId ${newTicketTypeId} not found in this event` };
    }

    const attendeeUpdates: Prisma.AttendeeUpdateInput = {};
    const a = input.attendee as Record<string, unknown> | undefined;
    if (a && typeof a === "object") {
      if (a.title != null) {
        const t = String(a.title);
        if (t === "") attendeeUpdates.title = null;
        else if (TITLE_VALUES.has(t)) attendeeUpdates.title = t as never;
        else return { error: `Invalid title. Must be one of: ${[...TITLE_VALUES].join(", ")}` };
      }
      if (a.firstName != null) attendeeUpdates.firstName = String(a.firstName).slice(0, 100);
      if (a.lastName != null) attendeeUpdates.lastName = String(a.lastName).slice(0, 100);
      if (a.organization != null) attendeeUpdates.organization = String(a.organization).slice(0, 255);
      if (a.jobTitle != null) attendeeUpdates.jobTitle = String(a.jobTitle).slice(0, 255);
      if (a.phone != null) attendeeUpdates.phone = String(a.phone).slice(0, 50);
      if (a.city != null) attendeeUpdates.city = String(a.city).slice(0, 255);
      if (a.country != null) attendeeUpdates.country = String(a.country).slice(0, 255);
      if (a.bio != null) attendeeUpdates.bio = String(a.bio).slice(0, 5000);
      if (a.specialty != null) attendeeUpdates.specialty = String(a.specialty).slice(0, 255);
      if (Array.isArray(a.tags)) {
        attendeeUpdates.tags = (a.tags as unknown[])
          .map((t) => normalizeTag(String(t).slice(0, 100)))
          .filter(Boolean);
      }
      if (a.dietaryReqs != null) attendeeUpdates.dietaryReqs = String(a.dietaryReqs).slice(0, 2000);
    }

    // Transaction: ticket type change needs soldCount adjustments on both tiers
    const result = await db.$transaction(async (tx) => {
      if (newTicketTypeId && newTicketTypeId !== existing.ticketTypeId) {
        if (existing.ticketTypeId) {
          await tx.ticketType.update({
            where: { id: existing.ticketTypeId },
            data: { soldCount: { decrement: 1 } },
          });
        }
        await tx.ticketType.update({
          where: { id: newTicketTypeId },
          data: { soldCount: { increment: 1 } },
        });
      }

      const regData: Prisma.RegistrationUpdateInput = {};
      if (status) regData.status = status as never;
      if (paymentStatus) regData.paymentStatus = paymentStatus as never;
      if (newTicketTypeId) regData.ticketType = { connect: { id: newTicketTypeId } };
      if (input.badgeType !== undefined) regData.badgeType = input.badgeType as string | null;
      if (input.dtcmBarcode !== undefined) regData.dtcmBarcode = input.dtcmBarcode as string | null;
      if (input.notes !== undefined) regData.notes = String(input.notes).slice(0, 2000);

      const updated = await tx.registration.update({
        where: { id: registrationId },
        data: regData,
        select: {
          id: true,
          status: true,
          paymentStatus: true,
          ticketTypeId: true,
          notes: true,
          attendee: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      });

      if (Object.keys(attendeeUpdates).length > 0) {
        await tx.attendee.update({
          where: { id: existing.attendeeId },
          data: attendeeUpdates,
        });
      }

      return updated;
    });

    await db.auditLog.create({
      data: {
        eventId: existing.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Registration",
        entityId: registrationId,
        changes: {
          source: "mcp",
          before: { status: existing.status, paymentStatus: existing.paymentStatus, ticketTypeId: existing.ticketTypeId },
          after: { status: result.status, paymentStatus: result.paymentStatus, ticketTypeId: result.ticketTypeId },
          attendeeFieldsChanged: Object.keys(attendeeUpdates),
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_registration audit-log-failed"));

    // Sync to contact store (fire-and-forget)
    if (Object.keys(attendeeUpdates).length > 0) {
      syncToContact({
        organizationId: ctx.organizationId,
        eventId: existing.eventId,
        email: result.attendee.email,
        firstName: result.attendee.firstName,
        lastName: result.attendee.lastName,
      }).catch((err) => apiLogger.error({ err }, "agent:update_registration contact-sync-failed"));
    }

    return { success: true, registration: result };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_registration failed");
    return { error: err instanceof Error ? err.message : "Failed to update registration" };
  }
};

const updateSpeaker: ToolExecutor = async (input, ctx) => {
  try {
    const speakerId = String(input.speakerId ?? "").trim();
    if (!speakerId) return { error: "speakerId is required" };

    const existing = await db.speaker.findFirst({
      where: { id: speakerId, event: { organizationId: ctx.organizationId } },
      select: { id: true, eventId: true, email: true, firstName: true, lastName: true, status: true },
    });
    if (!existing) return { error: `Speaker ${speakerId} not found or access denied` };

    const status = input.status ? String(input.status) : undefined;
    if (status && !SPEAKER_STATUSES.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...SPEAKER_STATUSES].join(", ")}` };
    }

    const updates: Prisma.SpeakerUpdateInput = {};
    if (status) updates.status = status as never;
    if (input.title != null) {
      const t = String(input.title);
      if (t === "") updates.title = null;
      else if (TITLE_VALUES.has(t)) updates.title = t as never;
      else return { error: `Invalid title. Must be one of: ${[...TITLE_VALUES].join(", ")}` };
    }
    if (input.firstName != null) updates.firstName = String(input.firstName).slice(0, 100);
    if (input.lastName != null) updates.lastName = String(input.lastName).slice(0, 100);
    if (input.bio != null) updates.bio = String(input.bio).slice(0, 5000);
    if (input.organization != null) updates.organization = String(input.organization).slice(0, 255);
    if (input.jobTitle != null) updates.jobTitle = String(input.jobTitle).slice(0, 255);
    if (input.phone != null) updates.phone = String(input.phone).slice(0, 50);
    if (input.city != null) updates.city = String(input.city).slice(0, 255);
    if (input.country != null) updates.country = String(input.country).slice(0, 255);
    if (input.specialty != null) updates.specialty = String(input.specialty).slice(0, 255);
    if (input.website != null) updates.website = String(input.website).slice(0, 500);
    if (input.photo !== undefined) updates.photo = input.photo as string | null;
    if (Array.isArray(input.tags)) {
      updates.tags = (input.tags as unknown[])
        .map((t) => normalizeTag(String(t).slice(0, 100)))
        .filter(Boolean);
    }

    if (Object.keys(updates).length === 0) {
      return { error: "No fields provided to update" };
    }

    const updated = await db.speaker.update({
      where: { id: speakerId },
      data: updates,
      select: {
        id: true,
        title: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
        organization: true,
        jobTitle: true,
      },
    });

    await db.auditLog.create({
      data: {
        eventId: existing.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Speaker",
        entityId: speakerId,
        changes: {
          source: "mcp",
          before: { status: existing.status },
          after: { status: updated.status },
          fieldsChanged: Object.keys(updates),
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_speaker audit-log-failed"));

    syncToContact({
      organizationId: ctx.organizationId,
      eventId: existing.eventId,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
    }).catch((err) => apiLogger.error({ err }, "agent:update_speaker contact-sync-failed"));

    return { success: true, speaker: updated };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_speaker failed");
    return { error: err instanceof Error ? err.message : "Failed to update speaker" };
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

const bulkUpdateRegistrationStatus: ToolExecutor = async (input, ctx) => {
  try {
    const rawIds = input.registrationIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return { error: "registrationIds must be a non-empty array" };
    }
    if (rawIds.length > 200) {
      return { error: "Max 200 registrationIds per call" };
    }
    const registrationIds = rawIds.map((x) => String(x).trim()).filter(Boolean);

    const status = input.status ? String(input.status) : undefined;
    if (status && !REGISTRATION_STATUSES.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...REGISTRATION_STATUSES].join(", ")}` };
    }
    const paymentStatus = input.paymentStatus ? String(input.paymentStatus) : undefined;
    if (paymentStatus && !ALL_PAYMENT_STATUSES.has(paymentStatus)) {
      return { error: `Invalid paymentStatus. Must be one of: ${[...ALL_PAYMENT_STATUSES].join(", ")}` };
    }
    if (!status && !paymentStatus) {
      return { error: "At least one of status or paymentStatus must be provided" };
    }

    const data: Prisma.RegistrationUpdateManyMutationInput = {};
    if (status) data.status = status as never;
    if (paymentStatus) data.paymentStatus = paymentStatus as never;

    const result = await db.registration.updateMany({
      where: {
        id: { in: registrationIds },
        event: { organizationId: ctx.organizationId },
      },
      data,
    });

    await db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "BULK_UPDATE",
        entityType: "Registration",
        entityId: `bulk-${result.count}`,
        changes: {
          source: "mcp",
          registrationIds,
          updates: { status, paymentStatus },
          updatedCount: result.count,
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:bulk_update_registration_status audit-log-failed"));

    return {
      success: true,
      updated: result.count,
      notFound: registrationIds.length - result.count,
      requestedCount: registrationIds.length,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:bulk_update_registration_status failed");
    return { error: err instanceof Error ? err.message : "Failed to bulk update" };
  }
};

// ─── Tranche C: Recently shipped features ─────────────────────────────────────

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

const getSpeakerAgreementTemplate: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { speakerAgreementTemplate: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    return { template: event.speakerAgreementTemplate ?? null };
  } catch (err) {
    apiLogger.error({ err }, "agent:get_speaker_agreement_template failed");
    return { error: "Failed to fetch speaker agreement template" };
  }
};

const listPromoCodes: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    const codes = await db.promoCode.findMany({
      where: { eventId: ctx.eventId },
      select: {
        id: true,
        code: true,
        description: true,
        discountType: true,
        discountValue: true,
        currency: true,
        maxUses: true,
        maxUsesPerEmail: true,
        usedCount: true,
        validFrom: true,
        validUntil: true,
        isActive: true,
        createdAt: true,
        ticketTypes: { select: { ticketTypeId: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      promoCodes: codes.map((c) => ({
        ...c,
        ticketTypeIds: c.ticketTypes.map((t) => t.ticketTypeId),
      })),
      total: codes.length,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_promo_codes failed");
    return { error: "Failed to list promo codes" };
  }
};

const createPromoCode: ToolExecutor = async (input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    const code = String(input.code ?? "").trim().toUpperCase();
    if (!code || code.length < 2 || code.length > 50) {
      return { error: "code is required (2-50 chars)" };
    }
    const discountType = String(input.discountType ?? "").trim();
    if (!DISCOUNT_TYPES.has(discountType)) {
      return { error: `discountType must be one of: ${[...DISCOUNT_TYPES].join(", ")}` };
    }
    const discountValue = Number(input.discountValue);
    if (isNaN(discountValue) || discountValue <= 0) {
      return { error: "discountValue must be a positive number" };
    }
    if (discountType === "PERCENTAGE" && discountValue > 100) {
      return { error: "PERCENTAGE discountValue must be <= 100" };
    }

    const existing = await db.promoCode.findFirst({
      where: { eventId: ctx.eventId, code },
      select: { id: true },
    });
    if (existing) return { error: `Promo code "${code}" already exists for this event` };

    const ticketTypeIds: string[] = Array.isArray(input.ticketTypeIds)
      ? (input.ticketTypeIds as unknown[]).map((t) => String(t))
      : [];
    if (ticketTypeIds.length > 0) {
      const valid = await db.ticketType.count({
        where: { id: { in: ticketTypeIds }, eventId: ctx.eventId },
      });
      if (valid !== ticketTypeIds.length) {
        return { error: "One or more ticketTypeIds not found in this event" };
      }
    }

    const promoCode = await db.promoCode.create({
      data: {
        eventId: ctx.eventId,
        code,
        description: input.description ? String(input.description).slice(0, 500) : null,
        discountType: discountType as never,
        discountValue,
        currency: input.currency ? String(input.currency).slice(0, 10) : null,
        maxUses: input.maxUses != null ? Math.max(1, Number(input.maxUses)) : null,
        maxUsesPerEmail: input.maxUsesPerEmail != null ? Math.max(1, Number(input.maxUsesPerEmail)) : 1,
        validFrom: input.validFrom ? new Date(String(input.validFrom)) : null,
        validUntil: input.validUntil ? new Date(String(input.validUntil)) : null,
        isActive: input.isActive != null ? Boolean(input.isActive) : true,
        ticketTypes: ticketTypeIds.length > 0
          ? { create: ticketTypeIds.map((tid) => ({ ticketTypeId: tid })) }
          : undefined,
      },
      select: {
        id: true,
        code: true,
        discountType: true,
        discountValue: true,
        isActive: true,
      },
    });

    return { success: true, promoCode };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_promo_code failed");
    return { error: err instanceof Error ? err.message : "Failed to create promo code" };
  }
};

const updatePromoCode: ToolExecutor = async (input, ctx) => {
  try {
    const promoCodeId = String(input.promoCodeId ?? "").trim();
    if (!promoCodeId) return { error: "promoCodeId is required" };

    const existing = await db.promoCode.findFirst({
      where: { id: promoCodeId, event: { organizationId: ctx.organizationId } },
      select: { id: true, eventId: true },
    });
    if (!existing) return { error: `Promo code ${promoCodeId} not found or access denied` };

    const updates: Prisma.PromoCodeUpdateInput = {};
    if (input.description !== undefined) {
      updates.description = input.description == null ? null : String(input.description).slice(0, 500);
    }
    if (input.discountType != null) {
      const dt = String(input.discountType);
      if (!DISCOUNT_TYPES.has(dt)) {
        return { error: `discountType must be one of: ${[...DISCOUNT_TYPES].join(", ")}` };
      }
      updates.discountType = dt as never;
    }
    if (input.discountValue != null) {
      const dv = Number(input.discountValue);
      if (isNaN(dv) || dv <= 0) return { error: "discountValue must be positive" };
      updates.discountValue = dv;
    }
    if (input.maxUses !== undefined) {
      updates.maxUses = input.maxUses == null ? null : Math.max(1, Number(input.maxUses));
    }
    if (input.validFrom !== undefined) {
      updates.validFrom = input.validFrom == null ? null : new Date(String(input.validFrom));
    }
    if (input.validUntil !== undefined) {
      updates.validUntil = input.validUntil == null ? null : new Date(String(input.validUntil));
    }
    if (input.isActive != null) updates.isActive = Boolean(input.isActive);

    if (Object.keys(updates).length === 0) {
      return { error: "No fields provided to update" };
    }

    const updated = await db.promoCode.update({
      where: { id: promoCodeId },
      data: updates,
      select: {
        id: true,
        code: true,
        discountType: true,
        discountValue: true,
        isActive: true,
        usedCount: true,
      },
    });

    return { success: true, promoCode: updated };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_promo_code failed");
    return { error: err instanceof Error ? err.message : "Failed to update promo code" };
  }
};

const deletePromoCode: ToolExecutor = async (input, ctx) => {
  try {
    const promoCodeId = String(input.promoCodeId ?? "").trim();
    if (!promoCodeId) return { error: "promoCodeId is required" };

    const existing = await db.promoCode.findFirst({
      where: { id: promoCodeId, event: { organizationId: ctx.organizationId } },
      select: { id: true, isActive: true, usedCount: true },
    });
    if (!existing) return { error: `Promo code ${promoCodeId} not found or access denied` };

    // Soft delete: flip isActive to false, preserve usage history
    const updated = await db.promoCode.update({
      where: { id: promoCodeId },
      data: { isActive: false },
      select: { id: true, code: true, isActive: true, usedCount: true },
    });

    return {
      success: true,
      promoCode: updated,
      note: "Promo code soft-deleted (isActive: false). Usage history preserved. To hard-delete, use the dashboard.",
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:delete_promo_code failed");
    return { error: err instanceof Error ? err.message : "Failed to delete promo code" };
  }
};

const listScheduledEmails: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    const rows = await db.scheduledEmail.findMany({
      where: { eventId: ctx.eventId },
      select: {
        id: true,
        recipientType: true,
        emailType: true,
        customSubject: true,
        scheduledFor: true,
        status: true,
        sentAt: true,
        successCount: true,
        failureCount: true,
        totalCount: true,
        lastError: true,
        createdAt: true,
      },
      orderBy: { scheduledFor: "desc" },
      take: 200,
    });

    return { scheduledEmails: rows, total: rows.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_scheduled_emails failed");
    return { error: "Failed to list scheduled emails" };
  }
};

const cancelScheduledEmail: ToolExecutor = async (input, ctx) => {
  try {
    const scheduledEmailId = String(input.scheduledEmailId ?? "").trim();
    if (!scheduledEmailId) return { error: "scheduledEmailId is required" };

    const existing = await db.scheduledEmail.findFirst({
      where: { id: scheduledEmailId, event: { organizationId: ctx.organizationId } },
      select: { id: true, status: true, eventId: true },
    });
    if (!existing) return { error: `Scheduled email ${scheduledEmailId} not found or access denied` };

    if (existing.status !== "PENDING") {
      return { error: `Cannot cancel: status is ${existing.status}. Only PENDING rows can be cancelled.` };
    }

    const updated = await db.scheduledEmail.update({
      where: { id: scheduledEmailId },
      data: { status: "CANCELLED" },
      select: { id: true, status: true, scheduledFor: true },
    });

    await db.auditLog.create({
      data: {
        eventId: existing.eventId,
        userId: ctx.userId,
        action: "CANCEL",
        entityType: "ScheduledEmail",
        entityId: scheduledEmailId,
        changes: { source: "mcp", previousStatus: "PENDING" },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:cancel_scheduled_email audit-log-failed"));

    return { success: true, scheduledEmail: updated };
  } catch (err) {
    apiLogger.error({ err }, "agent:cancel_scheduled_email failed");
    return { error: err instanceof Error ? err.message : "Failed to cancel scheduled email" };
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// Sprint A batch 2 (April 2026) — accommodation CREATE + invoice + email templates
// ═══════════════════════════════════════════════════════════════════════════════

// ─── A3: Accommodation CREATE flow ────────────────────────────────────────────

const listRoomTypes: ToolExecutor = async (input, ctx) => {
  try {
    const hotelId = input.hotelId ? String(input.hotelId) : undefined;

    const roomTypes = await db.roomType.findMany({
      where: {
        hotel: {
          eventId: ctx.eventId,
          ...(hotelId ? { id: hotelId } : {}),
          isActive: true,
        },
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        description: true,
        capacity: true,
        pricePerNight: true,
        currency: true,
        totalRooms: true,
        bookedRooms: true,
        hotel: { select: { id: true, name: true, stars: true } },
      },
      orderBy: { pricePerNight: "asc" },
    });

    return {
      roomTypes: roomTypes.map((r) => ({
        ...r,
        pricePerNight: Number(r.pricePerNight),
        available: r.totalRooms - r.bookedRooms,
      })),
      total: roomTypes.length,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_room_types failed");
    return { error: "Failed to list room types" };
  }
};

const createAccommodation: ToolExecutor = async (input, ctx) => {
  try {
    const registrationId = input.registrationId ? String(input.registrationId).trim() : undefined;
    const speakerId = input.speakerId ? String(input.speakerId).trim() : undefined;
    const roomTypeId = String(input.roomTypeId ?? "").trim();
    const checkInStr = String(input.checkIn ?? "").trim();
    const checkOutStr = String(input.checkOut ?? "").trim();

    if (!registrationId && !speakerId) {
      return { error: "Either registrationId or speakerId is required" };
    }
    if (!roomTypeId) return { error: "roomTypeId is required" };
    if (!checkInStr || !checkOutStr) return { error: "checkIn and checkOut are required (ISO 8601)" };

    const checkInDate = new Date(checkInStr);
    const checkOutDate = new Date(checkOutStr);
    if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
      return { error: "checkIn and checkOut must be valid ISO 8601 datetime strings" };
    }
    const nights = Math.ceil((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24));
    if (nights <= 0) return { error: "checkOut must be after checkIn" };

    const guestCount = Math.max(1, Number(input.guestCount ?? 1));

    // Validate event access + entities in parallel
    const [event, registration, speaker, roomType] = await Promise.all([
      db.event.findFirst({
        where: { id: ctx.eventId, organizationId: ctx.organizationId },
        select: { id: true },
      }),
      registrationId
        ? db.registration.findFirst({
            where: { id: registrationId, eventId: ctx.eventId },
            select: { id: true, accommodation: { select: { id: true } } },
          })
        : null,
      speakerId
        ? db.speaker.findFirst({
            where: { id: speakerId, eventId: ctx.eventId },
            select: { id: true, accommodation: { select: { id: true } } },
          })
        : null,
      db.roomType.findFirst({
        where: {
          id: roomTypeId,
          isActive: true,
          hotel: { eventId: ctx.eventId, isActive: true },
        },
        select: {
          id: true,
          capacity: true,
          pricePerNight: true,
          currency: true,
          bookedRooms: true,
          totalRooms: true,
        },
      }),
    ]);

    if (!event) return { error: "Event not found or access denied" };
    if (registrationId && !registration) return { error: `Registration ${registrationId} not found in this event` };
    if (speakerId && !speaker) return { error: `Speaker ${speakerId} not found in this event` };
    if (registration?.accommodation) {
      return {
        error: "Registration already has accommodation assigned",
        existingAccommodationId: registration.accommodation.id,
        suggestion: "Use update_accommodation_status to modify, or remove existing first",
      };
    }
    if (speaker?.accommodation) {
      return {
        error: "Speaker already has accommodation assigned",
        existingAccommodationId: speaker.accommodation.id,
        suggestion: "Use update_accommodation_status to modify, or remove existing first",
      };
    }
    if (!roomType) return { error: "Room type not found or inactive" };
    if (guestCount > roomType.capacity) {
      return { error: `guestCount (${guestCount}) exceeds room capacity (${roomType.capacity})` };
    }

    const totalPrice = Number(roomType.pricePerNight) * nights;

    // Atomic: overbooking guard inside tx + counter increment
    const accommodation = await db.$transaction(async (tx) => {
      const fresh = await tx.roomType.findUnique({
        where: { id: roomTypeId },
        select: { bookedRooms: true, totalRooms: true },
      });
      if (!fresh || fresh.bookedRooms >= fresh.totalRooms) {
        throw new Error("NO_ROOMS_AVAILABLE");
      }

      const created = await tx.accommodation.create({
        data: {
          eventId: ctx.eventId,
          ...(registrationId && { registrationId }),
          ...(speakerId && { speakerId }),
          roomTypeId,
          checkIn: checkInDate,
          checkOut: checkOutDate,
          guestCount,
          specialRequests: input.specialRequests ? String(input.specialRequests).slice(0, 1000) : null,
          totalPrice,
          currency: roomType.currency,
          status: "PENDING",
        },
        select: {
          id: true,
          status: true,
          checkIn: true,
          checkOut: true,
          guestCount: true,
          totalPrice: true,
          currency: true,
          roomType: { select: { name: true, hotel: { select: { name: true } } } },
        },
      });

      await tx.roomType.update({
        where: { id: roomTypeId },
        data: { bookedRooms: { increment: 1 } },
      });

      return created;
    });

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "CREATE",
        entityType: "Accommodation",
        entityId: accommodation.id,
        changes: {
          source: "mcp",
          registrationId: registrationId ?? null,
          speakerId: speakerId ?? null,
          roomTypeId,
          nights,
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:create_accommodation audit-log-failed"));

    return { success: true, accommodation: { ...accommodation, totalPrice: Number(accommodation.totalPrice), nights } };
  } catch (err) {
    if (err instanceof Error && err.message === "NO_ROOMS_AVAILABLE") {
      return { error: "No rooms available for this room type" };
    }
    apiLogger.error({ err }, "agent:create_accommodation failed");
    return { error: err instanceof Error ? err.message : "Failed to create accommodation" };
  }
};

const ACCOMMODATION_STATUSES_SET = new Set(["PENDING", "CONFIRMED", "CANCELLED", "CHECKED_IN", "CHECKED_OUT"]);

const updateAccommodationStatus: ToolExecutor = async (input, ctx) => {
  try {
    const accommodationId = String(input.accommodationId ?? "").trim();
    const status = String(input.status ?? "").trim();
    if (!accommodationId) return { error: "accommodationId is required" };
    if (!ACCOMMODATION_STATUSES_SET.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...ACCOMMODATION_STATUSES_SET].join(", ")}` };
    }

    const existing = await db.accommodation.findFirst({
      where: { id: accommodationId, event: { organizationId: ctx.organizationId } },
      select: { id: true, eventId: true, status: true, roomTypeId: true },
    });
    if (!existing) return { error: `Accommodation ${accommodationId} not found or access denied` };

    if (existing.status === status) {
      return { success: true, accommodation: existing, message: `Already in status ${status}` };
    }

    // Room counter adjustments around CANCELLED transitions (matches REST route logic)
    const wasActive = existing.status !== "CANCELLED";
    const willBeActive = status !== "CANCELLED";

    const updated = await db.$transaction(async (tx) => {
      if (wasActive && !willBeActive) {
        // active → CANCELLED: release the room
        await tx.roomType.update({
          where: { id: existing.roomTypeId },
          data: { bookedRooms: { decrement: 1 } },
        });
      } else if (!wasActive && willBeActive) {
        // CANCELLED → active: re-book the room, but guard against overbooking
        const fresh = await tx.roomType.findUnique({
          where: { id: existing.roomTypeId },
          select: { bookedRooms: true, totalRooms: true },
        });
        if (!fresh || fresh.bookedRooms >= fresh.totalRooms) {
          throw new Error("NO_ROOMS_AVAILABLE");
        }
        await tx.roomType.update({
          where: { id: existing.roomTypeId },
          data: { bookedRooms: { increment: 1 } },
        });
      }

      return tx.accommodation.update({
        where: { id: accommodationId },
        data: { status: status as never },
        select: {
          id: true,
          status: true,
          checkIn: true,
          checkOut: true,
          roomType: { select: { name: true, hotel: { select: { name: true } } } },
        },
      });
    });

    db.auditLog.create({
      data: {
        eventId: existing.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Accommodation",
        entityId: accommodationId,
        changes: { source: "mcp", before: existing.status, after: status },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_accommodation_status audit-log-failed"));

    return { success: true, accommodation: updated };
  } catch (err) {
    if (err instanceof Error && err.message === "NO_ROOMS_AVAILABLE") {
      return { error: "Cannot reinstate: no rooms available in that room type" };
    }
    apiLogger.error({ err }, "agent:update_accommodation_status failed");
    return { error: err instanceof Error ? err.message : "Failed to update accommodation status" };
  }
};

// ─── A4: Invoice CREATE / SEND flow ───────────────────────────────────────────

const INVOICE_STATUSES = new Set(["DRAFT", "SENT", "PAID", "OVERDUE", "CANCELLED", "REFUNDED"]);

const createInvoiceExec: ToolExecutor = async (input, ctx) => {
  try {
    const registrationId = String(input.registrationId ?? "").trim();
    if (!registrationId) return { error: "registrationId is required" };

    // Verify registration belongs to this org's event
    const registration = await db.registration.findFirst({
      where: { id: registrationId, event: { organizationId: ctx.organizationId } },
      select: { id: true, eventId: true },
    });
    if (!registration) return { error: `Registration ${registrationId} not found or access denied` };

    const { createInvoice } = await import("@/lib/invoice-service");
    const invoice = await createInvoice({
      registrationId,
      eventId: registration.eventId,
      organizationId: ctx.organizationId,
      dueDate: input.dueDate ? new Date(String(input.dueDate)) : undefined,
    });

    return {
      success: true,
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        type: invoice.type,
        status: invoice.status,
        total: Number(invoice.total),
        currency: invoice.currency,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
      },
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_invoice failed");
    return { error: err instanceof Error ? err.message : "Failed to create invoice" };
  }
};

const sendInvoiceExec: ToolExecutor = async (input, ctx) => {
  try {
    const invoiceId = String(input.invoiceId ?? "").trim();
    if (!invoiceId) return { error: "invoiceId is required" };

    const existing = await db.invoice.findFirst({
      where: { id: invoiceId, event: { organizationId: ctx.organizationId } },
      select: { id: true, eventId: true, invoiceNumber: true, status: true, registrationId: true },
    });
    if (!existing) return { error: `Invoice ${invoiceId} not found or access denied` };

    const { sendInvoiceEmail } = await import("@/lib/invoice-service");
    await sendInvoiceEmail(invoiceId);

    db.auditLog.create({
      data: {
        eventId: existing.eventId,
        userId: ctx.userId,
        action: "SEND",
        entityType: "Invoice",
        entityId: invoiceId,
        changes: { source: "mcp", invoiceNumber: existing.invoiceNumber },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:send_invoice audit-log-failed"));

    return { success: true, invoiceId, invoiceNumber: existing.invoiceNumber, emailed: true };
  } catch (err) {
    apiLogger.error({ err }, "agent:send_invoice failed");
    return { error: err instanceof Error ? err.message : "Failed to send invoice" };
  }
};

const updateInvoiceStatus: ToolExecutor = async (input, ctx) => {
  try {
    const invoiceId = String(input.invoiceId ?? "").trim();
    const status = String(input.status ?? "").trim();
    if (!invoiceId) return { error: "invoiceId is required" };
    if (!INVOICE_STATUSES.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...INVOICE_STATUSES].join(", ")}` };
    }

    const existing = await db.invoice.findFirst({
      where: { id: invoiceId, event: { organizationId: ctx.organizationId } },
      select: { id: true, eventId: true, invoiceNumber: true, status: true },
    });
    if (!existing) return { error: `Invoice ${invoiceId} not found or access denied` };

    const data: Prisma.InvoiceUpdateInput = { status: status as never };
    if (status === "PAID") data.paidDate = new Date();

    const updated = await db.invoice.update({
      where: { id: invoiceId },
      data,
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        total: true,
        currency: true,
        paidDate: true,
      },
    });

    db.auditLog.create({
      data: {
        eventId: existing.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Invoice",
        entityId: invoiceId,
        changes: {
          source: "mcp",
          before: existing.status,
          after: status,
          note: status === "REFUNDED" ? "DB flag only — Stripe refund not triggered" : undefined,
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_invoice_status audit-log-failed"));

    return {
      success: true,
      invoice: { ...updated, total: Number(updated.total) },
      ...(status === "REFUNDED" && {
        note: "Invoice marked REFUNDED in DB. This does NOT trigger a Stripe refund — use the dashboard for actual money movement.",
      }),
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_invoice_status failed");
    return { error: err instanceof Error ? err.message : "Failed to update invoice status" };
  }
};

// ─── A5: Email template editing ───────────────────────────────────────────────

const updateEmailTemplate: ToolExecutor = async (input, ctx) => {
  try {
    const slug = String(input.slug ?? "").trim();
    if (!slug) return { error: "slug is required (e.g. 'speaker-invitation', 'registration-confirmation')" };

    // Look up the event-specific template by slug. If none exists, we create one
    // (this is how the user "overrides" a default template).
    const existing = await db.emailTemplate.findFirst({
      where: { eventId: ctx.eventId, slug },
      select: { id: true, subject: true, htmlContent: true, textContent: true },
    });

    const subject = input.subject != null ? String(input.subject).slice(0, 500) : undefined;
    const htmlContent = input.htmlContent != null ? String(input.htmlContent).slice(0, 100000) : undefined;
    const textContent = input.textContent != null ? String(input.textContent).slice(0, 50000) : undefined;
    const name = input.name != null ? String(input.name).slice(0, 200) : undefined;

    if (subject === undefined && htmlContent === undefined && textContent === undefined) {
      return { error: "At least one of subject, htmlContent, or textContent must be provided" };
    }

    let updated;
    if (existing) {
      updated = await db.emailTemplate.update({
        where: { id: existing.id },
        data: {
          ...(subject !== undefined && { subject }),
          ...(htmlContent !== undefined && { htmlContent }),
          ...(textContent !== undefined && { textContent }),
          ...(name !== undefined && { name }),
        },
        select: { id: true, slug: true, name: true, subject: true },
      });
    } else {
      // No event-specific override yet — seed one. Pull defaults from email.ts
      // so the missing fields don't end up empty.
      const { getDefaultTemplate } = await import("@/lib/email");
      const defaultTpl = getDefaultTemplate(slug);
      if (!defaultTpl) {
        return { error: `Unknown template slug "${slug}". Check list_email_templates for valid slugs.` };
      }
      updated = await db.emailTemplate.create({
        data: {
          eventId: ctx.eventId,
          slug,
          name: name ?? defaultTpl.name,
          subject: subject ?? defaultTpl.subject,
          htmlContent: htmlContent ?? defaultTpl.htmlContent,
          textContent: textContent ?? defaultTpl.textContent,
          isActive: true,
        },
        select: { id: true, slug: true, name: true, subject: true },
      });
    }

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "EmailTemplate",
        entityId: updated.id,
        changes: {
          source: "mcp",
          slug,
          fieldsChanged: [
            ...(subject !== undefined ? ["subject"] : []),
            ...(htmlContent !== undefined ? ["htmlContent"] : []),
            ...(textContent !== undefined ? ["textContent"] : []),
          ],
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_email_template audit-log-failed"));

    return { success: true, template: updated };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_email_template failed");
    return { error: err instanceof Error ? err.message : "Failed to update email template" };
  }
};

const resetEmailTemplate: ToolExecutor = async (input, ctx) => {
  try {
    const slug = String(input.slug ?? "").trim();
    if (!slug) return { error: "slug is required" };

    const existing = await db.emailTemplate.findFirst({
      where: { eventId: ctx.eventId, slug },
      select: { id: true, slug: true },
    });
    if (!existing) {
      return {
        success: true,
        message: `No event-level override exists for "${slug}" — already using default template`,
      };
    }

    await db.emailTemplate.delete({ where: { id: existing.id } });

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "DELETE",
        entityType: "EmailTemplate",
        entityId: existing.id,
        changes: { source: "mcp", slug, note: "Reset to default — event-level override removed" },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:reset_email_template audit-log-failed"));

    return { success: true, slug, message: "Event-level override removed. The default template will be used on next send." };
  } catch (err) {
    apiLogger.error({ err }, "agent:reset_email_template failed");
    return { error: err instanceof Error ? err.message : "Failed to reset email template" };
  }
};

// ─── Tranche 2: bulk creates + update_contact + update_event ─────────────────

const BULK_MAX = 100;

const createSpeakersBulk: ToolExecutor = async (input, ctx) => {
  try {
    const items = Array.isArray(input.speakers) ? (input.speakers as unknown[]) : null;
    if (!items || !items.length) return { error: "speakers must be a non-empty array", code: "MISSING_SPEAKERS" };
    if (items.length > BULK_MAX) {
      return { error: `Max ${BULK_MAX} speakers per call; got ${items.length}`, code: "TOO_MANY_ROWS" };
    }

    // Pre-flight: de-dup the input by lowercased email so a duplicate row in
    // the same payload doesn't race against itself with a unique-constraint 500.
    const seenEmails = new Set<string>();
    const created: Array<{ index: number; id: string; email: string; firstName: string; lastName: string }> = [];
    const errors: Array<{ index: number; email?: string; error: string; code?: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const row = items[i] as Record<string, unknown>;
      try {
        const email = String(row.email ?? "").trim().toLowerCase();
        const firstName = String(row.firstName ?? "").trim();
        const lastName = String(row.lastName ?? "").trim();
        if (!email || !firstName || !lastName) {
          errors.push({ index: i, email: email || undefined, error: "email, firstName, lastName required", code: "MISSING_FIELDS" });
          continue;
        }
        if (!EMAIL_RE.test(email)) {
          errors.push({ index: i, email, error: "Invalid email format", code: "INVALID_EMAIL" });
          continue;
        }
        if (seenEmails.has(email)) {
          errors.push({ index: i, email, error: "Duplicate email in this batch", code: "DUPLICATE_IN_BATCH" });
          continue;
        }
        seenEmails.add(email);

        const title = row.title ? String(row.title) : undefined;
        if (title && !TITLE_VALUES.has(title)) {
          errors.push({ index: i, email, error: `Invalid title; must be one of ${[...TITLE_VALUES].join(", ")}`, code: "INVALID_TITLE" });
          continue;
        }
        const status = row.status ? String(row.status) : undefined;
        if (status && !SPEAKER_STATUSES.has(status)) {
          errors.push({ index: i, email, error: `Invalid status; must be one of ${[...SPEAKER_STATUSES].join(", ")}`, code: "INVALID_STATUS" });
          continue;
        }

        const existing = await db.speaker.findFirst({
          where: { eventId: ctx.eventId, email },
          select: { id: true },
        });
        if (existing) {
          errors.push({ index: i, email, error: `Speaker with email ${email} already exists`, code: "ALREADY_EXISTS" });
          continue;
        }

        const speaker = await db.speaker.create({
          data: {
            eventId: ctx.eventId,
            email,
            firstName,
            lastName,
            title: (title as never) ?? null,
            bio: row.bio ? String(row.bio).slice(0, 5000) : null,
            organization: row.organization ? String(row.organization).slice(0, 255) : null,
            jobTitle: row.jobTitle ? String(row.jobTitle).slice(0, 255) : null,
            phone: row.phone ? String(row.phone).slice(0, 50) : null,
            specialty: row.specialty ? String(row.specialty).slice(0, 255) : null,
            status: (status as never) ?? "INVITED",
          },
          select: { id: true, email: true, firstName: true, lastName: true },
        });
        created.push({ index: i, ...speaker });
      } catch (err) {
        errors.push({
          index: i,
          email: (items[i] as { email?: string }).email,
          error: err instanceof Error ? err.message : "Unknown error",
          code: "ROW_FAILED",
        });
      }
    }

    apiLogger.info(
      { eventId: ctx.eventId, created: created.length, failed: errors.length, total: items.length },
      "agent:create_speakers_bulk",
    );

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "CREATE",
        entityType: "Speaker",
        entityId: `bulk:${created.length}`,
        changes: { source: "mcp", bulk: true, created: created.length, failed: errors.length },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:create_speakers_bulk audit-log-failed"));

    return {
      success: true,
      createdCount: created.length,
      failedCount: errors.length,
      created,
      errors,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_speakers_bulk failed");
    return { error: err instanceof Error ? err.message : "Failed to bulk-create speakers" };
  }
};

const createRegistrationsBulk: ToolExecutor = async (input, ctx) => {
  try {
    const items = Array.isArray(input.registrations) ? (input.registrations as unknown[]) : null;
    if (!items || !items.length) return { error: "registrations must be a non-empty array", code: "MISSING_REGISTRATIONS" };
    if (items.length > BULK_MAX) {
      return { error: `Max ${BULK_MAX} registrations per call; got ${items.length}`, code: "TOO_MANY_ROWS" };
    }

    // Pre-load the event's ticket types once so we can validate ticketTypeId
    // without hitting the DB N times.
    const ticketTypes = await db.ticketType.findMany({
      where: { eventId: ctx.eventId },
      select: { id: true, name: true },
    });
    const ticketTypeById = new Map(ticketTypes.map((t) => [t.id, t]));

    const seenEmails = new Set<string>();
    const created: Array<{ index: number; registrationId: string; email: string; attendeeId: string }> = [];
    const errors: Array<{ index: number; email?: string; error: string; code?: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const row = items[i] as Record<string, unknown>;
      try {
        const email = String(row.email ?? "").trim().toLowerCase();
        const firstName = String(row.firstName ?? "").trim();
        const lastName = String(row.lastName ?? "").trim();
        const ticketTypeId = String(row.ticketTypeId ?? "").trim();
        if (!email || !firstName || !lastName || !ticketTypeId) {
          errors.push({ index: i, email: email || undefined, error: "email, firstName, lastName, ticketTypeId required", code: "MISSING_FIELDS" });
          continue;
        }
        if (!EMAIL_RE.test(email)) {
          errors.push({ index: i, email, error: "Invalid email format", code: "INVALID_EMAIL" });
          continue;
        }
        if (seenEmails.has(email)) {
          errors.push({ index: i, email, error: "Duplicate email in this batch", code: "DUPLICATE_IN_BATCH" });
          continue;
        }
        seenEmails.add(email);

        const ticketType = ticketTypeById.get(ticketTypeId);
        if (!ticketType) {
          errors.push({ index: i, email, error: `Ticket type ${ticketTypeId} not found for this event`, code: "INVALID_TICKET_TYPE" });
          continue;
        }

        const rawTitle = row.title ? String(row.title) : undefined;
        if (rawTitle && !TITLE_VALUES.has(rawTitle)) {
          errors.push({ index: i, email, error: `Invalid title`, code: "INVALID_TITLE" });
          continue;
        }
        const rawStatus = row.status ? String(row.status) : "CONFIRMED";
        if (!MANUAL_REGISTRATION_STATUSES.has(rawStatus)) {
          errors.push({ index: i, email, error: `Invalid status`, code: "INVALID_STATUS" });
          continue;
        }

        const duplicate = await db.registration.findFirst({
          where: { eventId: ctx.eventId, attendee: { email } },
          select: { id: true },
        });
        if (duplicate) {
          errors.push({ index: i, email, error: `Registration for ${email} already exists`, code: "ALREADY_EXISTS" });
          continue;
        }

        const result = await db.$transaction(async (tx) => {
          const attendee = await tx.attendee.create({
            data: {
              email,
              firstName,
              lastName,
              title: (rawTitle as never) ?? null,
              organization: row.organization ? String(row.organization).slice(0, 255) : null,
              jobTitle: row.jobTitle ? String(row.jobTitle).slice(0, 255) : null,
              phone: row.phone ? String(row.phone).slice(0, 50) : null,
              country: row.country ? String(row.country).slice(0, 255) : null,
              specialty: row.specialty ? String(row.specialty).slice(0, 255) : null,
              registrationType: ticketType.name,
            },
            select: { id: true, email: true },
          });
          const serialId = await getNextSerialId(tx, ctx.eventId);
          const registration = await tx.registration.create({
            data: {
              eventId: ctx.eventId,
              ticketTypeId: ticketType.id,
              attendeeId: attendee.id,
              serialId,
              status: rawStatus as never,
            },
            select: { id: true },
          });
          return { attendeeId: attendee.id, registrationId: registration.id };
        });

        created.push({ index: i, email, ...result });
      } catch (err) {
        errors.push({
          index: i,
          email: (items[i] as { email?: string }).email,
          error: err instanceof Error ? err.message : "Unknown error",
          code: "ROW_FAILED",
        });
      }
    }

    apiLogger.info(
      { eventId: ctx.eventId, created: created.length, failed: errors.length, total: items.length },
      "agent:create_registrations_bulk",
    );

    db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "CREATE",
        entityType: "Registration",
        entityId: `bulk:${created.length}`,
        changes: { source: "mcp", bulk: true, created: created.length, failed: errors.length },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:create_registrations_bulk audit-log-failed"));

    return {
      success: true,
      createdCount: created.length,
      failedCount: errors.length,
      created,
      errors,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_registrations_bulk failed");
    return { error: err instanceof Error ? err.message : "Failed to bulk-create registrations" };
  }
};

const updateContact: ToolExecutor = async (input, ctx) => {
  try {
    const contactId = String(input.contactId ?? "").trim();
    if (!contactId) return { error: "contactId is required", code: "MISSING_CONTACT_ID" };

    const existing = await db.contact.findFirst({
      where: { id: contactId, organizationId: ctx.organizationId },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    if (!existing) return { error: `Contact ${contactId} not found or access denied`, code: "CONTACT_NOT_FOUND" };

    const updates: Prisma.ContactUpdateInput = {};

    if (input.firstName != null) updates.firstName = String(input.firstName).slice(0, 100);
    if (input.lastName != null) updates.lastName = String(input.lastName).slice(0, 100);

    if (input.title != null) {
      const t = String(input.title);
      if (t === "") updates.title = null;
      else if (TITLE_VALUES.has(t)) updates.title = t as never;
      else return { error: `Invalid title`, code: "INVALID_TITLE" };
    }
    if (input.organization != null) updates.organization = String(input.organization).slice(0, 255);
    if (input.jobTitle != null) updates.jobTitle = String(input.jobTitle).slice(0, 255);
    if (input.bio != null) updates.bio = String(input.bio).slice(0, 5000);
    if (input.specialty != null) updates.specialty = String(input.specialty).slice(0, 255);
    if (input.phone != null) updates.phone = String(input.phone).slice(0, 50);
    if (input.photo !== undefined) updates.photo = input.photo as string | null;
    if (input.city != null) updates.city = String(input.city).slice(0, 255);
    if (input.state != null) updates.state = String(input.state).slice(0, 255);
    if (input.zipCode != null) updates.zipCode = String(input.zipCode).slice(0, 50);
    if (input.country != null) updates.country = String(input.country).slice(0, 255);
    if (input.notes != null) updates.notes = String(input.notes).slice(0, 10000);
    if (Array.isArray(input.tags)) {
      updates.tags = (input.tags as unknown[])
        .map((t) => normalizeTag(String(t).slice(0, 100)))
        .filter(Boolean);
    }
    // Email updates go through a separate flow (dedup / merge) — keep immutable here.
    if (input.email != null) {
      return {
        error: "email cannot be updated via this tool — use the dashboard contact merge flow",
        code: "EMAIL_IMMUTABLE",
      };
    }

    if (Object.keys(updates).length === 0) {
      return { error: "No fields provided to update", code: "NO_FIELDS" };
    }

    const updated = await db.contact.update({
      where: { id: contactId },
      data: updates,
      select: {
        id: true,
        title: true,
        firstName: true,
        lastName: true,
        email: true,
        organization: true,
        jobTitle: true,
        phone: true,
        city: true,
        country: true,
        tags: true,
      },
    });

    db.auditLog.create({
      data: {
        // Contacts are org-scoped, not event-scoped; we don't have an eventId
        // to attribute to. Skip the eventId field (audit log is org-wide).
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Contact",
        entityId: contactId,
        changes: { source: "mcp", fieldsChanged: Object.keys(updates) },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_contact audit-log-failed"));

    return { success: true, contact: updated };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_contact failed");
    return { error: err instanceof Error ? err.message : "Failed to update contact" };
  }
};

// Safe fields for update_event — everything in this set can be changed without
// breaking public URLs, email scheduling, Zoom provisioning, or timezone math.
// slug + startDate + endDate + eventType + timezone are intentionally excluded
// because they cascade to registered URLs, scheduled-email fire times, webinar
// provisioning, and session start/end math respectively.
const EVENT_UPDATE_FIELD_WHITELIST = new Set([
  "name",
  "description",
  "venue",
  "address",
  "city",
  "country",
  "tag",
  "specialty",
  "taxRate",
  "taxLabel",
  "bankDetails",
  "badgeVerticalOffset",
]);
const EVENT_UPDATE_FIELD_BLACKLIST = new Set([
  "slug",
  "startDate",
  "endDate",
  "eventType",
  "timezone",
  "organizationId",
  "id",
]);

const updateEvent: ToolExecutor = async (input, ctx) => {
  try {
    const eventId = String(input.eventId ?? "").trim();
    if (!eventId) return { error: "eventId is required", code: "MISSING_EVENT_ID" };

    const existing = await db.event.findFirst({
      where: { id: eventId, organizationId: ctx.organizationId },
      select: { id: true, name: true },
    });
    if (!existing) return { error: `Event ${eventId} not found or access denied`, code: "EVENT_NOT_FOUND" };

    // Reject any blacklisted field explicitly so the caller learns why and can
    // re-route through the dashboard (where cascading effects are handled).
    for (const key of Object.keys(input)) {
      if (key === "eventId") continue;
      if (EVENT_UPDATE_FIELD_BLACKLIST.has(key)) {
        return {
          error:
            `Field "${key}" cannot be changed via MCP because it cascades to ` +
            `public URLs, scheduled emails, Zoom provisioning, or timezone math. ` +
            `Use the dashboard Settings page instead.`,
          code: "FIELD_NOT_ALLOWED",
          field: key,
        };
      }
      if (key !== "eventId" && !EVENT_UPDATE_FIELD_WHITELIST.has(key)) {
        return {
          error: `Unknown field "${key}". Allowed: ${[...EVENT_UPDATE_FIELD_WHITELIST].join(", ")}`,
          code: "UNKNOWN_FIELD",
          field: key,
        };
      }
    }

    const updates: Prisma.EventUpdateInput = {};

    if (input.name != null) {
      const n = String(input.name).trim();
      if (n.length < 2 || n.length > 255) {
        return { error: "name must be 2-255 chars", code: "INVALID_NAME" };
      }
      updates.name = n;
    }
    if (input.description !== undefined) {
      updates.description = input.description === null ? null : String(input.description).slice(0, 5000);
    }
    if (input.venue !== undefined) updates.venue = input.venue === null ? null : String(input.venue).slice(0, 255);
    if (input.address !== undefined) updates.address = input.address === null ? null : String(input.address).slice(0, 500);
    if (input.city !== undefined) updates.city = input.city === null ? null : String(input.city).slice(0, 255);
    if (input.country !== undefined) updates.country = input.country === null ? null : String(input.country).slice(0, 255);
    if (input.tag !== undefined) updates.tag = input.tag === null ? null : String(input.tag).slice(0, 255);
    if (input.specialty !== undefined) updates.specialty = input.specialty === null ? null : String(input.specialty).slice(0, 255);

    if (input.taxRate !== undefined) {
      if (input.taxRate === null) {
        updates.taxRate = null;
      } else {
        const rate = Number(input.taxRate);
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
          return { error: "taxRate must be between 0 and 100", code: "INVALID_TAX_RATE" };
        }
        updates.taxRate = rate;
      }
    }
    if (input.taxLabel !== undefined) {
      updates.taxLabel = input.taxLabel === null ? null : String(input.taxLabel).slice(0, 50);
    }
    if (input.bankDetails !== undefined) {
      updates.bankDetails = input.bankDetails === null ? null : String(input.bankDetails).slice(0, 5000);
    }
    if (input.badgeVerticalOffset != null) {
      const offset = Math.round(Number(input.badgeVerticalOffset));
      if (!Number.isFinite(offset) || offset < -500 || offset > 500) {
        return { error: "badgeVerticalOffset must be between -500 and 500", code: "INVALID_BADGE_OFFSET" };
      }
      updates.badgeVerticalOffset = offset;
    }

    if (Object.keys(updates).length === 0) {
      return { error: "No fields provided to update", code: "NO_FIELDS" };
    }

    const updated = await db.event.update({
      where: { id: eventId },
      data: updates,
      select: {
        id: true,
        name: true,
        slug: true,
        venue: true,
        address: true,
        city: true,
        country: true,
        tag: true,
        specialty: true,
        taxRate: true,
        taxLabel: true,
        badgeVerticalOffset: true,
      },
    });

    db.auditLog.create({
      data: {
        eventId: updated.id,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Event",
        entityId: updated.id,
        changes: { source: "mcp", fieldsChanged: Object.keys(updates) },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_event audit-log-failed"));

    return { success: true, event: updated };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_event failed");
    return { error: err instanceof Error ? err.message : "Failed to update event" };
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
  // ─── MCP Expansion (April 2026) ───
  // Tranche 0
  create_event: createEvent,
  // Tranche A — orchestration reads
  get_event_dashboard: getEventDashboard,
  list_unpaid_registrations: listUnpaidRegistrations,
  list_speaker_agreements: listSpeakerAgreements,
  list_live_sessions_now: listLiveSessionsNow,
  search_event: searchEvent,
  // Tranche B — actions / updates
  update_registration: updateRegistration,
  update_speaker: updateSpeaker,
  update_session: updateSession,
  bulk_update_registration_status: bulkUpdateRegistrationStatus,
  // Tranche C — recently shipped features
  get_webinar_info: getWebinarInfo,
  list_webinar_attendance: listWebinarAttendance,
  list_webinar_engagement: listWebinarEngagement,
  list_sponsors: listSponsors,
  upsert_sponsors: upsertSponsors,
  get_speaker_agreement_template: getSpeakerAgreementTemplate,
  list_promo_codes: listPromoCodes,
  create_promo_code: createPromoCode,
  update_promo_code: updatePromoCode,
  delete_promo_code: deletePromoCode,
  list_scheduled_emails: listScheduledEmails,
  cancel_scheduled_email: cancelScheduledEmail,
  // ─── Sprint A batch 2 ───
  list_room_types: listRoomTypes,
  create_accommodation: createAccommodation,
  update_accommodation_status: updateAccommodationStatus,
  create_invoice: createInvoiceExec,
  send_invoice: sendInvoiceExec,
  update_invoice_status: updateInvoiceStatus,
  update_email_template: updateEmailTemplate,
  reset_email_template: resetEmailTemplate,
  // ─── Sprint B: reviewer assignment + abstract scoring ───
  assign_reviewer_to_abstract: assignReviewerToAbstract,
  unassign_reviewer_from_abstract: unassignReviewerFromAbstract,
  submit_abstract_review: submitAbstractReview,
  get_abstract_scores: getAbstractScores,
  // ─── Sprint B Tranche 2: bulk creates + update_contact + update_event ───
  create_speakers_bulk: createSpeakersBulk,
  create_registrations_bulk: createRegistrationsBulk,
  update_contact: updateContact,
  update_event: updateEvent,
};
