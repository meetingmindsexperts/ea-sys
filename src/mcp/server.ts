#!/usr/bin/env node
/**
 * EA-SYS MCP Server
 *
 * Exposes event management tools via the Model Context Protocol.
 * Connects directly to the database via Prisma — no HTTP proxy.
 *
 * Usage (stdio):
 *   npx tsx src/mcp/server.ts
 *
 * Configure in .mcp.json for Claude Code:
 *   { "mcpServers": { "ea-sys": { "command": "npx", "args": ["tsx", "src/mcp/server.ts"] } } }
 */

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
    const result = await runTool("list_event_info", {}, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "list_tracks",
  "List all tracks for an event.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_tracks", {}, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID });
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
    const result = await runTool("create_track", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID });
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
    const result = await runTool("list_speakers", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID });
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
    const result = await runTool("create_speaker", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID });
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
    const result = await runTool("list_registrations", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID });
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
    const result = await runTool("list_sessions", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID });
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
    const result = await runTool("create_session", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID });
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
    const result = await runTool("add_topic_to_session", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "list_ticket_types",
  "List registration types and their pricing tiers for an event.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const orgId = await getOrgId(eventId);
    const result = await runTool("list_ticket_types", {}, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID });
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
    const result = await runTool("create_ticket_type", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID });
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
    const result = await runTool("create_registration", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID });
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
    const result = await runTool("send_bulk_email", input, { eventId, organizationId: orgId, userId: SYSTEM_USER_ID });
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ── New Read Tools (not in existing agent) ───────────────────────────────────

server.tool(
  "list_abstracts",
  "List abstract submissions for an event.",
  {
    eventId: z.string().describe("Event ID"),
    status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED", "WITHDRAWN"]).optional(),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ eventId, status, limit }) => {
    const abstracts = await db.abstract.findMany({
      where: {
        eventId,
        ...(status && { status }),
      },
      select: {
        id: true, title: true, status: true, presentationType: true,
        reviewScore: true, specialty: true,
        speaker: { select: { firstName: true, lastName: true, email: true } },
        theme: { select: { name: true } },
      },
      take: Math.min(limit || 50, 200),
      orderBy: { createdAt: "desc" },
    });

    const text = abstracts.length === 0
      ? "No abstracts found."
      : `Found ${abstracts.length} abstracts:\n\n` + abstracts.map(a =>
        `"${a.title}"\n  Status: ${a.status} | Type: ${a.presentationType || "N/A"} | Score: ${a.reviewScore ?? "—"}\n  Speaker: ${a.speaker.firstName} ${a.speaker.lastName} <${a.speaker.email}>\n  Theme: ${a.theme?.name || "None"}`
      ).join("\n\n");

    return { content: [{ type: "text" as const, text }] };
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
  async ({ eventId, type, status, limit }) => {
    const invoices = await db.invoice.findMany({
      where: {
        eventId,
        ...(type && { type }),
        ...(status && { status }),
      },
      select: {
        id: true, invoiceNumber: true, type: true, status: true,
        total: true, currency: true, issueDate: true,
        registration: { select: { attendee: { select: { firstName: true, lastName: true, email: true } } } },
      },
      take: Math.min(limit || 50, 200),
      orderBy: { createdAt: "desc" },
    });

    const text = invoices.length === 0
      ? "No invoices found."
      : `Found ${invoices.length} documents:\n\n` + invoices.map(inv =>
        `${inv.invoiceNumber} (${inv.type})\n  Status: ${inv.status} | Total: ${inv.currency} ${Number(inv.total).toFixed(2)}\n  Date: ${inv.issueDate.toISOString().split("T")[0]}\n  For: ${inv.registration.attendee.firstName} ${inv.registration.attendee.lastName}`
      ).join("\n\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "get_event_stats",
  "Get a summary dashboard for an event: registration counts, revenue, check-in rate.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const [event, regStats, paymentStats, checkedIn] = await Promise.all([
      db.event.findUniqueOrThrow({
        where: { id: eventId },
        select: { name: true, code: true, status: true, startDate: true },
      }),
      db.registration.groupBy({
        by: ["status"],
        where: { eventId },
        _count: true,
      }),
      db.registration.groupBy({
        by: ["paymentStatus"],
        where: { eventId },
        _count: true,
      }),
      db.registration.count({
        where: { eventId, status: "CHECKED_IN" },
      }),
    ]);

    const totalRegs = regStats.reduce((sum, r) => sum + r._count, 0);
    const confirmed = regStats.find(r => r.status === "CONFIRMED")?._count || 0;
    const checkinRate = totalRegs > 0 ? ((checkedIn / totalRegs) * 100).toFixed(1) : "0";

    const regBreakdown = regStats.map(r => `  ${r.status}: ${r._count}`).join("\n");
    const payBreakdown = paymentStats.map(p => `  ${p.paymentStatus}: ${p._count}`).join("\n");

    const text = `Event: ${event.name} (${event.code || "no code"})\nStatus: ${event.status}\nDate: ${event.startDate.toISOString().split("T")[0]}\n\nRegistrations: ${totalRegs} total, ${confirmed} confirmed\n${regBreakdown}\n\nPayment Status:\n${payBreakdown}\n\nCheck-in: ${checkedIn}/${totalRegs} (${checkinRate}%)`;

    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "list_email_templates",
  "List available email templates for an event.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const templates = await db.emailTemplate.findMany({
      where: { eventId },
      select: { id: true, slug: true, name: true, subject: true, isActive: true },
      orderBy: { slug: "asc" },
    });

    const text = templates.length === 0
      ? "No email templates configured for this event."
      : templates.map(t =>
        `${t.name} (${t.slug}) — ${t.isActive ? "Active" : "Inactive"}\n  Subject: ${t.subject}`
      ).join("\n\n");

    return { content: [{ type: "text" as const, text }] };
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
