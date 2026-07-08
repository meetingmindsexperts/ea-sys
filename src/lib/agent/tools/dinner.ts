// Dinner RSVP — agent/MCP read tools.
// Exposes the dinner roster + per-night headcounts so the agent / n8n /
// claude.ai can answer "who's coming to the gala?" without a dashboard.
// Read-only in v1 (writes stay in the organizer UI). Docs: docs/DINNER_RSVP.md.
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { computeDinnerHeadcounts } from "@/lib/rsvp/rsvp";
import type { ToolExecutor } from "./_shared";

const listDinnerRsvps: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Math.max(Number(input?.limit) || 200, 1), 500);
    const statusFilter = input?.status ? String(input.status) : undefined;
    if (statusFilter && statusFilter !== "PENDING" && statusFilter !== "RESPONDED") {
      return { error: `Invalid status "${statusFilter}". Must be PENDING or RESPONDED.` };
    }

    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true, name: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    const [dinners, invites] = await Promise.all([
      db.rsvpDinner.findMany({
        where: { eventId: ctx.eventId },
        orderBy: [{ sortOrder: "asc" }, { dinnerAt: "asc" }],
        select: { id: true, name: true, dinnerAt: true, location: true },
      }),
      db.rsvpInvite.findMany({
        where: { eventId: ctx.eventId, ...(statusFilter ? { status: statusFilter as "PENDING" | "RESPONDED" } : {}) },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: {
          inviteeName: true,
          inviteeEmail: true,
          status: true,
          dietary: true,
          respondedAt: true,
          responses: { select: { dinnerId: true, attending: true, guestCount: true } },
        },
      }),
    ]);

    const dinnerName = new Map(dinners.map((d) => [d.id, d.name]));
    const headcounts = computeDinnerHeadcounts(dinners, invites).map((h) => ({
      dinner: dinnerName.get(h.dinnerId) ?? h.dinnerId,
      attendees: h.attendees,
      guests: h.guests,
      totalSeats: h.total,
    }));

    const responded = invites.filter((i) => i.status === "RESPONDED").length;

    return {
      event: event.name,
      dinners: dinners.map((d) => ({
        name: d.name,
        dinnerAt: d.dinnerAt,
        location: d.location,
      })),
      headcountsByDinner: headcounts,
      summary: {
        totalInvited: invites.length,
        responded,
        pending: invites.length - responded,
      },
      invitees: invites.map((i) => ({
        name: i.inviteeName,
        email: i.inviteeEmail,
        status: i.status,
        respondedAt: i.respondedAt,
        dietary: i.dietary || undefined,
        attending: i.responses
          .filter((r) => r.attending)
          .map((r) => ({ dinner: dinnerName.get(r.dinnerId) ?? r.dinnerId, guests: r.guestCount })),
      })),
    };
  } catch (err) {
    apiLogger.error({ err, eventId: ctx.eventId }, "agent:list_dinner_rsvps-failed");
    return { error: "Failed to load dinner RSVPs" };
  }
};

export const DINNER_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_dinner_rsvps",
    description:
      "List the event's dinner RSVPs: each dinner with its per-night headcount (attendees + guests + total seats), an invited/responded/pending summary, and per-invitee responses (which dinners they're attending, guest counts, dietary needs). Optional status filter (PENDING / RESPONDED) and limit (default 200, max 500).",
    input_schema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["PENDING", "RESPONDED"], description: "Filter invitees by response status." },
        limit: { type: "number", description: "Max invitees to return (default 200, max 500)." },
      },
      required: [],
    },
  },
];

export const DINNER_EXECUTORS: Record<string, ToolExecutor> = {
  list_dinner_rsvps: listDinnerRsvps,
};
