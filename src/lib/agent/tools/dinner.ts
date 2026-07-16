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

    // (review H4) The headcounts and the summary MUST be computed over EVERY
    // invite — not over the truncated, status-filtered page.
    //
    // They used to share one query: `invites` was fetched with `take: limit`
    // (default 200) AND the optional status filter, and that same array was fed
    // to computeDinnerHeadcounts and to `summary.totalInvited`. Two ways the
    // agent then handed the operator a confidently wrong number:
    //   (1) 260 invitees → seats reported for only the oldest 200, so the
    //       caterer is under-ordered by ~25%, with no truncation flag;
    //   (2) status:"PENDING" → headcounts computed over people who by definition
    //       have no responses → every dinner reports 0 attendees / 0 seats,
    //       still presented as the authoritative headcount.
    // The dashboard roster computes over ALL invites, so the two surfaces
    // disagreed — and the agent is the one briefing the caterer.
    //
    // So: aggregate over the full set; paginate only the `invitees[]` we return.
    const [dinners, allInvites, pagedInvites] = await Promise.all([
      db.rsvpDinner.findMany({
        where: { eventId: ctx.eventId },
        orderBy: [{ sortOrder: "asc" }, { dinnerAt: "asc" }],
        select: { id: true, name: true, dinnerAt: true, location: true },
      }),
      // Aggregate set — no take, no status filter.
      db.rsvpInvite.findMany({
        where: { eventId: ctx.eventId },
        select: {
          status: true,
          responses: { select: { dinnerId: true, attending: true, guestCount: true } },
        },
      }),
      // Display set — paged + filtered as the caller asked.
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
    const headcounts = computeDinnerHeadcounts(dinners, allInvites).map((h) => ({
      dinner: dinnerName.get(h.dinnerId) ?? h.dinnerId,
      attendees: h.attendees,
      guests: h.guests,
      totalSeats: h.total,
    }));

    const responded = allInvites.filter((i) => i.status === "RESPONDED").length;
    const invites = pagedInvites;
    // R2 M9: the truncation flag must compare against the FILTERED total,
    // not allInvites — with a status filter set, the old `&& !statusFilter`
    // clause hard-coded false, so the agent claimed a complete PENDING list
    // while a third was missing (the same "confidently wrong number" class
    // as the H4 headcount fix above).
    const filteredTotal = statusFilter
      ? statusFilter === "RESPONDED"
        ? responded
        : allInvites.length - responded
      : allInvites.length;

    return {
      event: event.name,
      dinners: dinners.map((d) => ({
        name: d.name,
        dinnerAt: d.dinnerAt,
        location: d.location,
      })),
      headcountsByDinner: headcounts,
      summary: {
        // Over the WHOLE event, never the page.
        totalInvited: allInvites.length,
        responded,
        pending: allInvites.length - responded,
      },
      // So the agent can say "showing 200 of 260" instead of implying it has
      // the full list.
      inviteesTruncated: pagedInvites.length < filteredTotal,
      inviteesShown: pagedInvites.length,
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
