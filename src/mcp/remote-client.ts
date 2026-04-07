#!/usr/bin/env node
/**
 * EA-SYS MCP Remote Client
 *
 * A lightweight stdio-to-HTTP bridge for Claude Desktop.
 * Receives MCP messages via stdin, forwards them to the EA-SYS HTTP endpoint,
 * and returns responses via stdout.
 *
 * Usage: Set MCP_API_KEY and MCP_SERVER_URL env vars, then run via Claude Desktop config.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_URL = process.env.MCP_SERVER_URL || "https://events.meetingmindsgroup.com/api/mcp";
const API_KEY = process.env.MCP_API_KEY || "";

if (!API_KEY) {
  console.error("ERROR: MCP_API_KEY environment variable is required");
  process.exit(1);
}

// Helper: call the remote EA-SYS API directly (not MCP-over-HTTP, just REST)
async function callApi(path: string, options?: RequestInit): Promise<unknown> {
  const url = SERVER_URL.replace("/api/mcp", "") + path;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      ...(options?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

const server = new McpServer({ name: "ea-sys-remote", version: "1.0.0" });

// ── Tools ────────────────────────────────────────────────────────────────────

server.tool(
  "list_events",
  "List all events in the organization.",
  {},
  async () => {
    const events = await callApi("/api/events") as Array<{ id: string; name: string; slug: string; status: string; startDate: string; endDate: string; _count?: { registrations: number; speakers: number } }>;
    const text = events.length === 0 ? "No events found." :
      events.map(e => `${e.name}\n  ID: ${e.id}\n  Status: ${e.status}\n  Dates: ${e.startDate?.split("T")[0] || "?"} to ${e.endDate?.split("T")[0] || "?"}`).join("\n\n");
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "list_speakers",
  "List speakers for an event.",
  { eventId: z.string().describe("Event ID"), status: z.string().optional() },
  async ({ eventId, status }) => {
    const params = status ? `?status=${status}` : "";
    const speakers = await callApi(`/api/events/${eventId}/speakers${params}`) as Array<{ firstName: string; lastName: string; email: string; status: string; organization?: string }>;
    const text = speakers.length === 0 ? "No speakers found." :
      speakers.map(s => `${s.firstName} ${s.lastName} <${s.email}> — ${s.status}${s.organization ? ` (${s.organization})` : ""}`).join("\n");
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "list_registrations",
  "List registrations for an event.",
  {
    eventId: z.string().describe("Event ID"),
    status: z.string().optional(),
    paymentStatus: z.string().optional(),
  },
  async ({ eventId, status, paymentStatus }) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (paymentStatus) params.set("paymentStatus", paymentStatus);
    const qs = params.toString() ? `?${params}` : "";
    const regs = await callApi(`/api/events/${eventId}/registrations${qs}`) as Array<{ id: string; status: string; paymentStatus: string; attendee: { firstName: string; lastName: string; email: string } }>;
    const text = regs.length === 0 ? "No registrations found." :
      `${regs.length} registrations:\n\n` + regs.slice(0, 100).map(r =>
        `${r.attendee.firstName} ${r.attendee.lastName} <${r.attendee.email}> — ${r.status} / ${r.paymentStatus}`
      ).join("\n");
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "list_sessions",
  "List sessions for an event.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const sessions = await callApi(`/api/events/${eventId}/sessions`) as Array<{ id: string; name: string; startTime: string; endTime: string; location?: string; track?: { name: string } }>;
    const text = sessions.length === 0 ? "No sessions found." :
      sessions.map(s => `${s.name}\n  ${s.startTime?.split("T")[1]?.slice(0,5) || "?"} - ${s.endTime?.split("T")[1]?.slice(0,5) || "?"} | ${s.track?.name || "No track"} | ${s.location || "TBD"}`).join("\n\n");
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "list_tracks",
  "List tracks for an event.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const tracks = await callApi(`/api/events/${eventId}/tracks`) as Array<{ id: string; name: string; color?: string }>;
    const text = tracks.length === 0 ? "No tracks found." :
      tracks.map(t => `${t.name} (${t.id})`).join("\n");
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "list_ticket_types",
  "List registration types for an event.",
  { eventId: z.string().describe("Event ID") },
  async ({ eventId }) => {
    const tickets = await callApi(`/api/events/${eventId}/tickets`) as Array<{ id: string; name: string; price?: string; currency?: string; soldCount?: number; quantity?: number }>;
    const text = tickets.length === 0 ? "No ticket types found." :
      tickets.map(t => `${t.name} (${t.id}) — ${t.currency || "USD"} ${t.price || "0"} | Sold: ${t.soldCount || 0}/${t.quantity || "∞"}`).join("\n");
    return { content: [{ type: "text" as const, text }] };
  }
);

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("EA-SYS remote MCP client connected");
}

main().catch(err => {
  console.error("Failed to start:", err);
  process.exit(1);
});
