#!/usr/bin/env node
/**
 * EA-SYS MCP Server
 *
 * Exposes event management tools via the Model Context Protocol.
 * Connects directly to the database via Prisma — no HTTP proxy.
 *
 * IMPORTANT: Stdio transport uses stdout for MCP messages.
 * ALL application logging MUST go to stderr to avoid corrupting the protocol.
 *
 * Usage (stdio):
 *   npx tsx src/mcp/server.ts
 *
 * Configure in .mcp.json for Claude Code:
 *   { "mcpServers": { "ea-sys": { "command": "npx", "args": ["tsx", "src/mcp/server.ts"] } } }
 */

// Force all Pino logging to stderr BEFORE any imports touch the logger
process.env.MCP_STDIO_MODE = "1";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TOOL_EXECUTOR_MAP, type AgentContext } from "../lib/agent/event-tools.js";
import { db } from "../lib/db.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Run an existing agent tool executor and return text for MCP */
async function runTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: AgentContext
): Promise<string> {
  const executor = TOOL_EXECUTOR_MAP[toolName];
  if (!executor) throw new Error(`Unknown tool: ${toolName}`);
  const result = await executor(input, ctx);
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

/** Resolve organizationId from an eventId */
async function getOrgId(eventId: string): Promise<string> {
  const event = await db.event.findUniqueOrThrow({
    where: { id: eventId },
    select: { organizationId: true },
  });
  return event.organizationId;
}

/** Default context for tools that need userId (non-critical for read ops) */
const SYSTEM_USER_ID = "mcp-server";

// ── Server Setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "ea-sys",
  version: "1.0.0",
});

// ── Organization-Level Tools (new for MCP) ───────────────────────────────────

server.tool(
  "list_events",
  "List all events in the organization with status, dates, and registration counts.",
  { organizationId: z.string().optional().describe("Organization ID (uses first org if omitted)") },
  async ({ organizationId }) => {
    let orgId = organizationId;
    if (!orgId) {
      const org = await db.organization.findFirst({ select: { id: true } });
      if (!org) return { content: [{ type: "text" as const, text: "No organization found." }] };
      orgId = org.id;
    }

    const events = await db.event.findMany({
      where: { organizationId: orgId },
      select: {
        id: true, name: true, slug: true, code: true, status: true,
        startDate: true, endDate: true, venue: true, city: true,
        eventType: true,
        _count: { select: { registrations: true, speakers: true, eventSessions: true } },
      },
      orderBy: { startDate: "desc" },
    });

    const text = events.length === 0
      ? "No events found."
      : events.map(e =>
        `${e.name} (${e.code || e.slug})\n  ID: ${e.id}\n  Status: ${e.status} | Type: ${e.eventType || "N/A"}\n  Dates: ${e.startDate.toISOString().split("T")[0]} to ${e.endDate.toISOString().split("T")[0]}\n  Venue: ${e.venue || "TBD"}, ${e.city || ""}\n  Registrations: ${e._count.registrations} | Speakers: ${e._count.speakers} | Sessions: ${e._count.eventSessions}`
      ).join("\n\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "list_contacts",
  "Search organization contacts by name, email, or tag.",
  {
    search: z.string().optional().describe("Search by name or email"),
    tag: z.string().optional().describe("Filter by tag"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ search, tag, limit }) => {
    const org = await db.organization.findFirst({ select: { id: true } });
    if (!org) return { content: [{ type: "text" as const, text: "No organization found." }] };

    const contacts = await db.contact.findMany({
      where: {
        organizationId: org.id,
        ...(search && {
          OR: [
            { firstName: { contains: search, mode: "insensitive" as const } },
            { lastName: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
          ],
        }),
        ...(tag && { tags: { has: tag } }),
      },
      select: {
        id: true, firstName: true, lastName: true, email: true,
        organization: true, jobTitle: true, tags: true,
      },
      take: Math.min(limit || 50, 200),
      orderBy: { lastName: "asc" },
    });

    const text = contacts.length === 0
      ? "No contacts found."
      : `Found ${contacts.length} contacts:\n\n` + contacts.map(c =>
        `${c.firstName} ${c.lastName} <${c.email}>${c.organization ? ` — ${c.organization}` : ""}${c.tags?.length ? ` [${(c.tags as string[]).join(", ")}]` : ""}`
      ).join("\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

// ── Event-Level Tools (wrapping existing agent executors) ────────────────────

server.tool(
  "get_event_info",
  "Get event details including name, dates, venue, status, and counts of registrations, speakers, sessions.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_event_info", {}, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "list_tracks",
  "List all tracks for an event.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_tracks", {}, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "create_track",
  "Create a new track for organizing sessions.",
  {
    eventId: z.string().describe("Event ID"),
    name: z.string().describe("Track name"),
    color: z.string().optional().describe("Hex color, e.g. #3B82F6"),
    description: z.string().optional().describe("Track description"),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("create_track", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "list_speakers",
  "List speakers for an event. Optionally filter by status.",
  {
    eventId: z.string().describe("Event ID"),
    status: z.enum(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]).optional(),
    limit: z.number().optional().describe("Max results (default 50, max 200)"),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_speakers", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "create_speaker",
  "Add a new speaker to an event.",
  {
    eventId: z.string().describe("Event ID"),
    email: z.string().describe("Speaker email"),
    firstName: z.string().describe("First name"),
    lastName: z.string().describe("Last name"),
    title: z.enum(["DR", "MR", "MRS", "MS", "PROF"]).optional(),
    bio: z.string().optional(),
    organization: z.string().optional(),
    jobTitle: z.string().optional(),
    specialty: z.string().optional(),
    status: z.enum(["INVITED", "CONFIRMED"]).optional(),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("create_speaker", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "list_registrations",
  "List registrations for an event with optional filters.",
  {
    eventId: z.string().describe("Event ID"),
    status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"]).optional(),
    paymentStatus: z.enum(["UNPAID", "PENDING", "PAID", "COMPLIMENTARY", "REFUNDED"]).optional(),
    limit: z.number().optional().describe("Max results (default 50, max 200)"),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_registrations", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "list_sessions",
  "List sessions/schedule for an event.",
  {
    eventId: z.string().describe("Event ID"),
    trackId: z.string().optional().describe("Filter by track ID"),
    limit: z.number().optional().describe("Max results (default 50, max 100)"),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_sessions", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "create_session",
  "Create a new session with optional session-level roles and topics. Topics represent individual talks within a session, each with their own speakers.",
  {
    eventId: z.string().describe("Event ID"),
    name: z.string().describe("Session title"),
    startTime: z.string().describe("ISO datetime, e.g. 2026-06-01T09:00:00Z"),
    endTime: z.string().describe("ISO datetime"),
    trackId: z.string().optional(),
    location: z.string().optional(),
    description: z.string().optional(),
    speakerIds: z.array(z.string()).optional().describe("Speaker IDs (assigned as SPEAKER role)"),
    sessionRoles: z.array(z.object({
      speakerId: z.string(),
      role: z.enum(["SPEAKER", "MODERATOR", "CHAIRPERSON", "PANELIST"]),
    })).optional().describe("Session-level speaker roles"),
    topics: z.array(z.object({
      title: z.string(),
      duration: z.number().optional().describe("Duration in minutes"),
      speakerIds: z.array(z.string()).optional(),
    })).optional().describe("Topics within the session, each with optional speakers"),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("create_session", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "add_topic_to_session",
  "Add a topic (individual talk/agenda item) to an existing session. Each topic can have its own speakers.",
  {
    eventId: z.string().describe("Event ID"),
    sessionId: z.string().describe("Session ID to add the topic to"),
    title: z.string().describe("Topic title"),
    duration: z.number().optional().describe("Duration in minutes"),
    speakerIds: z.array(z.string()).optional().describe("Speaker IDs for this topic"),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("add_topic_to_session", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "list_ticket_types",
  "List registration types and their pricing tiers for an event.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_ticket_types", {}, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "create_ticket_type",
  "Create a new registration type with auto-generated pricing tiers (Early Bird, Standard, Onsite).",
  {
    eventId: z.string().describe("Event ID"),
    name: z.string().describe("Registration type name, e.g. 'Delegate', 'VIP'"),
    description: z.string().optional(),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("create_ticket_type", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "create_registration",
  "Manually register an attendee for an event.",
  {
    eventId: z.string().describe("Event ID"),
    email: z.string().describe("Attendee email"),
    firstName: z.string().describe("First name"),
    lastName: z.string().describe("Last name"),
    ticketTypeId: z.string().describe("Ticket type ID"),
    title: z.enum(["DR", "MR", "MRS", "MS", "PROF"]).optional(),
    organization: z.string().optional(),
    status: z.enum(["PENDING", "CONFIRMED", "WAITLISTED"]).optional(),
    pricingTierId: z.string().optional(),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("create_registration", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "send_bulk_email",
  "Send an email to speakers or registrations for an event.",
  {
    eventId: z.string().describe("Event ID"),
    recipientType: z.enum(["speakers", "registrations"]).describe("Who to email"),
    emailType: z.string().describe("E.g. 'invitation', 'reminder', 'custom'"),
    subject: z.string().describe("Email subject"),
    htmlMessage: z.string().describe("HTML email body"),
    statusFilter: z.string().optional().describe("Filter recipients by status, e.g. 'CONFIRMED'"),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("send_bulk_email", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ── Abstract Management Tools ────────────────────────────────────────────────

server.tool(
  "list_abstract_themes",
  "List abstract themes configured for an event.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_abstract_themes", {}, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "create_abstract_theme",
  "Create an abstract theme for an event.",
  {
    eventId: z.string().describe("Event ID"),
    name: z.string().describe("Theme name"),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("create_abstract_theme", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "list_review_criteria",
  "List review criteria configured for an event, including weights.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_review_criteria", {}, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "create_review_criterion",
  "Create a review criterion for an event.",
  {
    eventId: z.string().describe("Event ID"),
    name: z.string().describe("Criterion name"),
    weight: z.number().describe("Weight (1-10)"),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("create_review_criterion", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "update_abstract_status",
  "Update the status of an abstract (accept, reject, request revision).",
  {
    eventId: z.string().describe("Event ID"),
    abstractId: z.string().describe("Abstract ID"),
    status: z.enum(["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"]),
    reviewNotes: z.string().optional().describe("Notes for the author"),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("update_abstract_status", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ── Accommodation Tools ──────────────────────────────────────────────────────

server.tool(
  "list_hotels",
  "List hotels configured for an event.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_hotels", {}, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "create_hotel",
  "Add a hotel for an event.",
  {
    eventId: z.string().describe("Event ID"),
    name: z.string().describe("Hotel name"),
    address: z.string().optional(),
    stars: z.number().optional().describe("Star rating (1-5)"),
    contactEmail: z.string().optional(),
    contactPhone: z.string().optional(),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("create_hotel", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "list_accommodations",
  "List room bookings for an event with guest details.",
  {
    eventId: z.string().describe("Event ID"),
    status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "CHECKED_IN", "CHECKED_OUT"]).optional(),
    limit: z.number().optional(),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_accommodations", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ── Media Tool ───────────────────────────────────────────────────────────────

server.tool(
  "list_media",
  "List media files in the organization library.",
  {
    eventId: z.string().describe("Event ID (used to resolve organization)"),
    limit: z.number().optional(),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_media", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ── Check-in Tool ────────────────────────────────────────────────────────────

server.tool(
  "check_in_registration",
  "Mark a registration as checked in at the event.",
  {
    eventId: z.string().describe("Event ID"),
    registrationId: z.string().describe("Registration ID"),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("check_in_registration", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ── Contact CRUD Tool ────────────────────────────────────────────────────────

server.tool(
  "create_contact",
  "Create a new contact in the organization.",
  {
    eventId: z.string().describe("Event ID (used to resolve organization)"),
    email: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    organization: z.string().optional(),
    jobTitle: z.string().optional(),
    phone: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("create_contact", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ── Reviewer Tool ────────────────────────────────────────────────────────────

server.tool(
  "list_reviewers",
  "List reviewers assigned to an event.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_reviewers", {}, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ── Read Tools (using shared executors) ──────────────────────────────────────

server.tool(
  "list_abstracts",
  "List abstract submissions for an event.",
  {
    eventId: z.string().describe("Event ID"),
    status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED", "WITHDRAWN"]).optional(),
    themeId: z.string().optional().describe("Filter by theme ID"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_abstracts", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "list_invoices",
  "List invoices, receipts, or credit notes for an event.",
  {
    eventId: z.string().describe("Event ID"),
    type: z.enum(["INVOICE", "RECEIPT", "CREDIT_NOTE"]).optional(),
    status: z.enum(["DRAFT", "SENT", "PAID", "OVERDUE", "CANCELLED", "REFUNDED"]).optional(),
    limit: z.number().optional(),
  },
  async ({ eventId, ...input }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_invoices", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "get_event_stats",
  "Get a summary dashboard for an event: registration counts, payment breakdown, check-in rate.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("get_event_stats", {}, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "list_email_templates",
  "List available email templates for an event.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_email_templates", {}, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ── Start Server ─────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("EA-SYS MCP server running on stdio");
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
