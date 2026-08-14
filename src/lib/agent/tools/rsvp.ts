// RSVP — agent/MCP read tools.
// Exposes the roster + per-item headcounts so the agent / n8n / claude.ai can
// answer "who's coming to the gala?" or "who signed up for Workshop B?" without
// a dashboard. Read-only in v1 (writes stay in the organizer UI).
//
// Renamed from list_dinner_rsvps on Aug 14, 2026 when an event gained the
// ability to run SEVERAL RSVPs. Without a campaign filter the tool aggregates
// across every RSVP on the event, which would silently mix a 30-person dinner
// with a 200-person workshop into one meaningless headcount — so the response
// is grouped BY campaign, and `campaignId` narrows it.
//
// Docs: docs/RSVP.md.
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { computeItemHeadcounts } from "@/lib/rsvp/rsvp";
import type { ToolExecutor } from "./_shared";

const listRsvps: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Math.max(Number(input?.limit) || 200, 1), 500);
    const statusFilter = input?.status ? String(input.status) : undefined;
    if (statusFilter && statusFilter !== "PENDING" && statusFilter !== "RESPONDED") {
      return { error: `Invalid status "${statusFilter}". Must be PENDING or RESPONDED.` };
    }
    const campaignFilter = input?.campaignId ? String(input.campaignId) : undefined;

    // Session (API-key) org lane for the swept RsvpCampaign/Item/Invite reads.
    return await runWithTenant(ctx.organizationId, async () => {
      const event = await db.event.findFirst({
        where: { id: ctx.eventId, organizationId: ctx.organizationId },
        select: { id: true, name: true },
      });
      if (!event) return { error: "Event not found or access denied" };

      const campaigns = await db.rsvpCampaign.findMany({
        where: { eventId: ctx.eventId, ...(campaignFilter ? { id: campaignFilter } : {}) },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          name: true,
          description: true,
          selectionMode: true,
          allowGuests: true,
          collectDietary: true,
          isActive: true,
        },
      });
      if (campaignFilter && campaigns.length === 0) {
        return { error: `RSVP "${campaignFilter}" not found on this event.` };
      }

      // (review H4) The headcounts and the summary MUST be computed over EVERY
      // invite — not over the truncated, status-filtered page.
      //
      // They used to share one query: `invites` was fetched with `take: limit`
      // (default 200) AND the optional status filter, and that same array was fed
      // to the headcount helper and to `summary.totalInvited`. Two ways the
      // agent then handed the operator a confidently wrong number:
      //   (1) 260 invitees → seats reported for only the oldest 200, so the
      //       caterer is under-ordered by ~25%, with no truncation flag;
      //   (2) status:"PENDING" → headcounts computed over people who by definition
      //       have no responses → every item reports 0 attendees / 0 seats,
      //       still presented as the authoritative headcount.
      // The dashboard roster computes over ALL invites, so the two surfaces
      // disagreed — and the agent is the one briefing the caterer.
      //
      // So: aggregate over the full set; paginate only the `invitees[]` we return.
      const campaignIds = campaigns.map((c) => c.id);
      const [items, allInvites, pagedInvites] = await Promise.all([
        db.rsvpItem.findMany({
          where: { campaignId: { in: campaignIds } },
          orderBy: [{ sortOrder: "asc" }, { startsAt: "asc" }],
          select: { id: true, campaignId: true, name: true, startsAt: true, location: true },
        }),
        // Aggregate set — no take, no status filter.
        db.rsvpInvite.findMany({
          where: { campaignId: { in: campaignIds } },
          select: {
            campaignId: true,
            status: true,
            responses: { select: { itemId: true, attending: true, guestCount: true } },
          },
        }),
        // Display set — paged + filtered as the caller asked.
        db.rsvpInvite.findMany({
          where: {
            campaignId: { in: campaignIds },
            ...(statusFilter ? { status: statusFilter as "PENDING" | "RESPONDED" } : {}),
          },
          orderBy: { createdAt: "asc" },
          take: limit,
          select: {
            campaignId: true,
            inviteeName: true,
            inviteeEmail: true,
            status: true,
            dietary: true,
            respondedAt: true,
            responses: { select: { itemId: true, attending: true, guestCount: true } },
          },
        }),
      ]);

      const itemName = new Map(items.map((i) => [i.id, i.name]));
      const campaignName = new Map(campaigns.map((c) => [c.id, c.name]));

      const responded = allInvites.filter((i) => i.status === "RESPONDED").length;
      // The truncation flag must compare against the FILTERED total (R2 M9).
      const filteredTotal = statusFilter
        ? statusFilter === "RESPONDED"
          ? responded
          : allInvites.length - responded
        : allInvites.length;

      return {
        event: event.name,
        // Grouped by campaign so a dinner headcount and a workshop headcount
        // are never added together.
        rsvps: campaigns.map((c) => {
          const cItems = items.filter((i) => i.campaignId === c.id);
          const cInvites = allInvites.filter((i) => i.campaignId === c.id);
          const cResponded = cInvites.filter((i) => i.status === "RESPONDED").length;
          return {
            id: c.id,
            name: c.name,
            description: c.description,
            selectionMode: c.selectionMode,
            allowGuests: c.allowGuests,
            collectDietary: c.collectDietary,
            isActive: c.isActive,
            items: cItems.map((i) => ({ name: i.name, startsAt: i.startsAt, location: i.location })),
            headcountsByItem: computeItemHeadcounts(cItems, cInvites).map((h) => ({
              item: itemName.get(h.itemId) ?? h.itemId,
              attendees: h.attendees,
              guests: h.guests,
              totalSeats: h.total,
            })),
            summary: {
              // Over the WHOLE campaign, never the page.
              totalInvited: cInvites.length,
              responded: cResponded,
              pending: cInvites.length - cResponded,
            },
          };
        }),
        summary: {
          totalInvited: allInvites.length,
          responded,
          pending: allInvites.length - responded,
        },
        // So the agent can say "showing 200 of 260" instead of implying it has
        // the full list.
        inviteesTruncated: pagedInvites.length < filteredTotal,
        inviteesShown: pagedInvites.length,
        invitees: pagedInvites.map((i) => ({
          rsvp: campaignName.get(i.campaignId) ?? i.campaignId,
          name: i.inviteeName,
          email: i.inviteeEmail,
          status: i.status,
          respondedAt: i.respondedAt,
          dietary: i.dietary || undefined,
          attending: i.responses
            .filter((r) => r.attending)
            .map((r) => ({ item: itemName.get(r.itemId) ?? r.itemId, guests: r.guestCount })),
        })),
      };
    });
  } catch (err) {
    apiLogger.error({ err, eventId: ctx.eventId }, "agent:list_rsvps-failed");
    return { error: "Failed to load RSVPs" };
  }
};

export const RSVP_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_rsvps",
    description:
      "List the event's RSVPs (a gala dinner, parallel workshops, a site visit — an event can run several, each with its own guest list). Returns each RSVP with its items, per-item headcounts (attendees + guests + total seats), an invited/responded/pending summary, and per-invitee responses (which items they're attending, guest counts, dietary needs). Optional campaignId to narrow to one RSVP, status filter (PENDING / RESPONDED) and limit (default 200, max 500).",
    input_schema: {
      type: "object" as const,
      properties: {
        campaignId: {
          type: "string",
          description: "Narrow to a single RSVP by its id. Omit to return every RSVP on the event.",
        },
        status: {
          type: "string",
          enum: ["PENDING", "RESPONDED"],
          description: "Filter invitees by response status.",
        },
        limit: { type: "number", description: "Max invitees to return (default 200, max 500)." },
      },
      required: [],
    },
  },
];

export const RSVP_EXECUTORS: Record<string, ToolExecutor> = {
  list_rsvps: listRsvps,
};
