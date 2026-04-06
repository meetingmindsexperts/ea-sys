import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { validateApiKey } from "@/lib/api-key";
import { apiLogger } from "@/lib/logger";
import { TOOL_EXECUTOR_MAP, type AgentContext } from "@/lib/agent/event-tools";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Auth ─────────────────────────────────────────────────────────────────────

async function authenticate(req: Request): Promise<{ organizationId: string } | null> {
  const authHeader = req.headers.get("authorization");
  const apiKeyHeader = req.headers.get("x-api-key");
  const key = apiKeyHeader || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);
  if (!key) return null;
  return validateApiKey(key);
}

// ── Build MCP Server (fresh per request in stateless mode) ──────────────────

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "ea-sys", version: "1.0.0" });

  // ── Organization-level tools ──

  server.tool(
    "list_events",
    "List all events in the organization.",
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
          id: true, name: true, slug: true, code: true, status: true,
          startDate: true, endDate: true, venue: true, city: true, eventType: true,
          _count: { select: { registrations: true, speakers: true, eventSessions: true } },
        },
        orderBy: { startDate: "desc" },
      });
      const text = events.length === 0 ? "No events found." : events.map(e =>
        `${e.name} (${e.code || e.slug})\n  ID: ${e.id}\n  Status: ${e.status}\n  Dates: ${e.startDate.toISOString().split("T")[0]} to ${e.endDate.toISOString().split("T")[0]}\n  Registrations: ${e._count.registrations} | Speakers: ${e._count.speakers} | Sessions: ${e._count.eventSessions}`
      ).join("\n\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "list_contacts",
    "Search organization contacts.",
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

  // ── Event-level tools (wrap existing executors) ──

  const eventTools: Array<{
    name: string; description: string;
    params: Record<string, z.ZodTypeAny>;
    agentTool: string;
  }> = [
    { name: "get_event_info", description: "Get event details and counts.", params: {}, agentTool: "list_event_info" },
    { name: "list_tracks", description: "List all tracks for an event.", params: {}, agentTool: "list_tracks" },
    { name: "list_ticket_types", description: "List registration types and pricing.", params: {}, agentTool: "list_ticket_types" },
    { name: "list_speakers", description: "List speakers for an event.", params: {
      status: z.enum(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]).optional(),
      limit: z.number().optional(),
    }, agentTool: "list_speakers" },
    { name: "list_registrations", description: "List registrations with filters.", params: {
      status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"]).optional(),
      paymentStatus: z.enum(["UNPAID", "PENDING", "PAID", "COMPLIMENTARY", "REFUNDED"]).optional(),
      limit: z.number().optional(),
    }, agentTool: "list_registrations" },
    { name: "list_sessions", description: "List sessions for an event.", params: {
      trackId: z.string().optional(), limit: z.number().optional(),
    }, agentTool: "list_sessions" },
  ];

  for (const t of eventTools) {
    server.tool(
      t.name, t.description,
      { eventId: z.string().describe("Event ID"), ...t.params },
      async (args) => {
        const { eventId, ...input } = args;
        const orgId = await getOrgId(eventId as string);
        const result = await runTool(t.agentTool, input, { eventId: eventId as string, organizationId: orgId, userId: SYSTEM_USER_ID });
        return { content: [{ type: "text" as const, text: result }] };
      }
    );
  }

  // Write tools
  const writeTools: Array<{ name: string; description: string; params: Record<string, z.ZodTypeAny>; agentTool: string }> = [
    { name: "create_track", description: "Create a new track.", params: {
      name: z.string(), color: z.string().optional(), description: z.string().optional(),
    }, agentTool: "create_track" },
    { name: "create_speaker", description: "Add a speaker.", params: {
      email: z.string(), firstName: z.string(), lastName: z.string(),
      title: z.enum(["DR", "MR", "MRS", "MS", "PROF"]).optional(),
      bio: z.string().optional(), organization: z.string().optional(),
      jobTitle: z.string().optional(), status: z.enum(["INVITED", "CONFIRMED"]).optional(),
    }, agentTool: "create_speaker" },
    { name: "create_session", description: "Create a session with optional topics and session roles.", params: {
      name: z.string(), startTime: z.string(), endTime: z.string(),
      trackId: z.string().optional(), location: z.string().optional(),
      description: z.string().optional(), speakerIds: z.array(z.string()).optional(),
      sessionRoles: z.array(z.object({ speakerId: z.string(), role: z.enum(["SPEAKER", "MODERATOR", "CHAIRPERSON", "PANELIST"]) })).optional(),
      topics: z.array(z.object({ title: z.string(), duration: z.number().optional(), speakerIds: z.array(z.string()).optional() })).optional(),
    }, agentTool: "create_session" },
    { name: "add_topic_to_session", description: "Add a topic to an existing session with optional speakers.", params: {
      sessionId: z.string(), title: z.string(), duration: z.number().optional(),
      speakerIds: z.array(z.string()).optional(),
    }, agentTool: "add_topic_to_session" },
    { name: "create_ticket_type", description: "Create a registration type.", params: {
      name: z.string(), description: z.string().optional(),
    }, agentTool: "create_ticket_type" },
    { name: "create_registration", description: "Register an attendee.", params: {
      email: z.string(), firstName: z.string(), lastName: z.string(), ticketTypeId: z.string(),
      title: z.enum(["DR", "MR", "MRS", "MS", "PROF"]).optional(),
      organization: z.string().optional(), status: z.enum(["PENDING", "CONFIRMED", "WAITLISTED"]).optional(),
    }, agentTool: "create_registration" },
    { name: "send_bulk_email", description: "Email speakers or registrations.", params: {
      recipientType: z.enum(["speakers", "registrations"]),
      emailType: z.string(), subject: z.string(), htmlMessage: z.string(),
      statusFilter: z.string().optional(),
    }, agentTool: "send_bulk_email" },
  ];

  for (const t of writeTools) {
    server.tool(
      t.name, t.description,
      { eventId: z.string().describe("Event ID"), ...t.params },
      async (args) => {
        const { eventId, ...input } = args;
        const orgId = await getOrgId(eventId as string);
        const result = await runTool(t.agentTool, input, { eventId: eventId as string, organizationId: orgId, userId: SYSTEM_USER_ID });
        return { content: [{ type: "text" as const, text: result }] };
      }
    );
  }

  // ── New read-only tools ──

  server.tool(
    "list_abstracts", "List abstract submissions for an event.",
    {
      eventId: z.string(),
      status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED", "WITHDRAWN"]).optional(),
      limit: z.number().optional(),
    },
    async ({ eventId, status, limit }) => {
      const abstracts = await db.abstract.findMany({
        where: { eventId, ...(status && { status }) },
        select: {
          id: true, title: true, status: true, presentationType: true, reviewScore: true,
          speaker: { select: { firstName: true, lastName: true, email: true } },
          theme: { select: { name: true } },
        },
        take: Math.min(limit || 50, 200),
        orderBy: { createdAt: "desc" },
      });
      const text = abstracts.length === 0 ? "No abstracts found." :
        abstracts.map(a => `"${a.title}" — ${a.status}\n  Speaker: ${a.speaker.firstName} ${a.speaker.lastName}\n  Score: ${a.reviewScore ?? "—"} | Theme: ${a.theme?.name || "None"}`).join("\n\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "get_event_stats", "Get registration counts, payment breakdown, and check-in rate for an event.",
    { eventId: z.string() },
    async ({ eventId }) => {
      const [event, regStats, payStats, checkedIn] = await Promise.all([
        db.event.findUniqueOrThrow({ where: { id: eventId }, select: { name: true, code: true, status: true, startDate: true } }),
        db.registration.groupBy({ by: ["status"], where: { eventId }, _count: true }),
        db.registration.groupBy({ by: ["paymentStatus"], where: { eventId }, _count: true }),
        db.registration.count({ where: { eventId, status: "CHECKED_IN" } }),
      ]);
      const total = regStats.reduce((s, r) => s + r._count, 0);
      const rate = total > 0 ? ((checkedIn / total) * 100).toFixed(1) : "0";
      const text = `${event.name} (${event.code || "—"})\nStatus: ${event.status} | Date: ${event.startDate.toISOString().split("T")[0]}\n\nRegistrations: ${total}\n${regStats.map(r => `  ${r.status}: ${r._count}`).join("\n")}\n\nPayments:\n${payStats.map(p => `  ${p.paymentStatus}: ${p._count}`).join("\n")}\n\nCheck-in: ${checkedIn}/${total} (${rate}%)`;
      return { content: [{ type: "text" as const, text }] };
    }
  );

  return server;
}

// ── Route Handler ────────────────────────────────────────────────────────────

async function handleMcp(req: Request): Promise<Response> {
  // Auth check
  const authResult = await authenticate(req);
  if (!authResult) {
    return new Response(JSON.stringify({ error: "Unauthorized. Provide API key via x-api-key header or Authorization: Bearer." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Stateless transport — each request is independent
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcpServer = buildMcpServer();

  await mcpServer.connect(transport);
  const response = await transport.handleRequest(req);
  return response;
}

export async function GET(req: Request) {
  apiLogger.info({ msg: "MCP GET request received" });
  return handleMcp(req);
}

export async function POST(req: Request) {
  return handleMcp(req);
}

export async function DELETE(req: Request) {
  return handleMcp(req);
}
