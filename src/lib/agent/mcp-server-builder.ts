/**
 * Shared MCP server builder used by both Streamable HTTP and SSE transports.
 * Registers all EA-SYS event management tools on a fresh McpServer instance.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { TOOL_EXECUTOR_MAP, type AgentContext } from "@/lib/agent/event-tools";

const SYSTEM_USER_ID = "mcp-remote";

async function runTool(name: string, input: Record<string, unknown>, ctx: AgentContext): Promise<string> {
  const executor = TOOL_EXECUTOR_MAP[name];
  if (!executor) throw new Error(`Unknown tool: ${name}`);
  const result = await executor(input, ctx);
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

async function getOrgId(eventId: string): Promise<string> {
  const event = await db.event.findUniqueOrThrow({
    where: { id: eventId },
    select: { organizationId: true },
  });
  return event.organizationId;
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "ea-sys", version: "1.0.0" });

  // ── Organization-level tools ──

  server.tool(
    "list_events", "List all events in the organization.",
    { organizationId: z.string().optional() },
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
          id: true, name: true, slug: true, status: true,
          startDate: true, endDate: true, venue: true, city: true, eventType: true,
          _count: { select: { registrations: true, speakers: true, eventSessions: true } },
        },
        orderBy: { startDate: "desc" },
      });
      const text = events.length === 0 ? "No events found." : events.map(e =>
        `${e.name} (${e.slug})\n  ID: ${e.id}\n  Status: ${e.status}\n  Dates: ${e.startDate.toISOString().split("T")[0]} to ${e.endDate.toISOString().split("T")[0]}\n  Registrations: ${e._count.registrations} | Speakers: ${e._count.speakers} | Sessions: ${e._count.eventSessions}`
      ).join("\n\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "list_contacts", "Search organization contacts.",
    { search: z.string().optional(), tag: z.string().optional(), limit: z.number().optional() },
    async ({ search, tag, limit }) => {
      const org = await db.organization.findFirst({ select: { id: true } });
      if (!org) return { content: [{ type: "text" as const, text: "No organization found." }] };
      const contacts = await db.contact.findMany({
        where: {
          organizationId: org.id,
          ...(search && { OR: [
            { firstName: { contains: search, mode: "insensitive" as const } },
            { lastName: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
          ]}),
          ...(tag && { tags: { has: tag } }),
        },
        select: { firstName: true, lastName: true, email: true, organization: true, tags: true },
        take: Math.min(limit || 50, 200),
        orderBy: { lastName: "asc" },
      });
      const text = contacts.length === 0 ? "No contacts found." :
        contacts.map(c => `${c.firstName} ${c.lastName} <${c.email}>${c.organization ? ` — ${c.organization}` : ""}`).join("\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── Event-level read tools ──

  const readTools: Array<{ name: string; description: string; params: Record<string, z.ZodTypeAny>; agentTool?: string }> = [
    { name: "get_event_info", description: "Get event details and counts.", params: {}, agentTool: "list_event_info" },
    { name: "list_tracks", description: "List all tracks for an event.", params: {} },
    { name: "list_ticket_types", description: "List registration types and pricing.", params: {} },
    { name: "list_speakers", description: "List speakers.", params: {
      status: z.enum(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]).optional(), limit: z.number().optional(),
    }},
    { name: "list_registrations", description: "List registrations.", params: {
      status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"]).optional(),
      paymentStatus: z.enum(["UNPAID", "PENDING", "PAID", "COMPLIMENTARY", "REFUNDED"]).optional(),
      limit: z.number().optional(),
    }},
    { name: "list_sessions", description: "List sessions.", params: { trackId: z.string().optional(), limit: z.number().optional() }},
    { name: "list_abstracts", description: "List abstract submissions.", params: {
      status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED", "WITHDRAWN"]).optional(),
      themeId: z.string().optional(), limit: z.number().optional(),
    }},
    { name: "list_abstract_themes", description: "List abstract themes.", params: {} },
    { name: "list_review_criteria", description: "List review criteria.", params: {} },
    { name: "list_hotels", description: "List hotels.", params: {} },
    { name: "list_accommodations", description: "List room bookings.", params: {
      status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "CHECKED_IN", "CHECKED_OUT"]).optional(), limit: z.number().optional(),
    }},
    { name: "list_media", description: "List media files.", params: { limit: z.number().optional() }},
    { name: "list_reviewers", description: "List event reviewers.", params: {} },
    { name: "list_invoices", description: "List invoices/receipts/credit notes.", params: {
      type: z.enum(["INVOICE", "RECEIPT", "CREDIT_NOTE"]).optional(),
      status: z.enum(["DRAFT", "SENT", "PAID", "OVERDUE", "CANCELLED", "REFUNDED"]).optional(),
      limit: z.number().optional(),
    }},
    { name: "list_email_templates", description: "List email templates.", params: {} },
    { name: "get_event_stats", description: "Get event statistics dashboard.", params: {} },
  ];

  // ── Event-level write tools ──

  const writeTools: Array<{ name: string; description: string; params: Record<string, z.ZodTypeAny>; agentTool?: string }> = [
    { name: "create_track", description: "Create a track.", params: { name: z.string(), color: z.string().optional(), description: z.string().optional() }},
    { name: "create_speaker", description: "Add a speaker.", params: {
      email: z.string(), firstName: z.string(), lastName: z.string(),
      title: z.enum(["DR", "MR", "MRS", "MS", "PROF"]).optional(),
      bio: z.string().optional(), organization: z.string().optional(), jobTitle: z.string().optional(),
      status: z.enum(["INVITED", "CONFIRMED"]).optional(),
    }},
    { name: "create_session", description: "Create a session.", params: {
      name: z.string(), startTime: z.string(), endTime: z.string(),
      trackId: z.string().optional(), location: z.string().optional(), description: z.string().optional(),
      speakerIds: z.array(z.string()).optional(),
      sessionRoles: z.array(z.object({ speakerId: z.string(), role: z.enum(["SPEAKER", "MODERATOR", "CHAIRPERSON", "PANELIST"]) })).optional(),
      topics: z.array(z.object({ title: z.string(), duration: z.number().optional(), speakerIds: z.array(z.string()).optional() })).optional(),
    }},
    { name: "add_topic_to_session", description: "Add a topic to a session.", params: {
      sessionId: z.string(), title: z.string(), duration: z.number().optional(), speakerIds: z.array(z.string()).optional(),
    }},
    { name: "create_ticket_type", description: "Create a registration type.", params: { name: z.string(), description: z.string().optional() }},
    { name: "create_registration", description: "Register an attendee.", params: {
      email: z.string(), firstName: z.string(), lastName: z.string(), ticketTypeId: z.string(),
      title: z.enum(["DR", "MR", "MRS", "MS", "PROF"]).optional(),
      organization: z.string().optional(), status: z.enum(["PENDING", "CONFIRMED", "WAITLISTED"]).optional(),
    }},
    { name: "send_bulk_email", description: "Email speakers or registrations.", params: {
      recipientType: z.enum(["speakers", "registrations"]), emailType: z.string(),
      subject: z.string(), htmlMessage: z.string(), statusFilter: z.string().optional(),
    }},
    { name: "create_abstract_theme", description: "Create an abstract theme.", params: { name: z.string() }},
    { name: "create_review_criterion", description: "Create a review criterion.", params: { name: z.string(), weight: z.number() }},
    { name: "update_abstract_status", description: "Update abstract status.", params: {
      abstractId: z.string(), status: z.enum(["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"]),
      reviewNotes: z.string().optional(),
    }},
    { name: "create_hotel", description: "Add a hotel.", params: {
      name: z.string(), address: z.string().optional(), stars: z.number().optional(),
      contactEmail: z.string().optional(), contactPhone: z.string().optional(),
    }},
    { name: "check_in_registration", description: "Check in a registration.", params: { registrationId: z.string() }},
    { name: "create_contact", description: "Create a contact.", params: {
      email: z.string(), firstName: z.string(), lastName: z.string(),
      organization: z.string().optional(), jobTitle: z.string().optional(),
      phone: z.string().optional(), city: z.string().optional(), country: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }},
  ];

  // Register all event-level tools
  for (const t of [...readTools, ...writeTools]) {
    server.tool(
      t.name, t.description,
      { eventId: z.string().describe("Event ID"), ...t.params },
      async (args) => {
        const { eventId, ...input } = args;
        const orgId = await getOrgId(eventId as string);
        const result = await runTool(t.agentTool || t.name, input, { eventId: eventId as string, organizationId: orgId, userId: SYSTEM_USER_ID });
        return { content: [{ type: "text" as const, text: result }] };
      }
    );
  }

  return server;
}
