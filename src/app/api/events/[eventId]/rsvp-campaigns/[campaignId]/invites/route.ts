/**
 * RSVP invite list / roster for ONE campaign (organizer).
 *
 *   GET            → roster (invites + per-item responses) + headcount tiles
 *                    + the campaign's config. `?export=csv` streams a CSV.
 *   POST           → bulk-add invitees (picker or manual). Mints a token per
 *                    invitee; de-dups on (campaignId, email) — an email already
 *                    invited TO THIS CAMPAIGN is skipped (not errored).
 *
 * The de-dup key is the campaign, not the event: that is precisely what lets
 * the same person sit on the dinner list AND the workshop list.
 *
 * Org-scoped; POST is denyReviewer-guarded + rate-limited. The token is the
 * invitee's link key; it is returned so the UI can copy/send links.
 * Docs: docs/RSVP.md.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordExport } from "@/lib/audit-data-transfer";
import { denyReviewer } from "@/lib/auth-guards";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited, zodErrorResponse, apiErrorResponse } from "@/lib/api-errors";
import {
  computeItemHeadcounts,
  generateRsvpToken,
  normalizeRsvpEmail,
  rsvpInviteBulkSchema,
} from "@/lib/rsvp/rsvp";
import { loadRsvpEvent, loadRsvpCampaign } from "@/lib/rsvp/server";

type RouteParams = { params: Promise<{ eventId: string; campaignId: string }> };

// Quote/escape + formula-injection neutralization (invitee names/dietary are
// respondent-controlled).
import { escapeCsvCell as csvCell } from "@/lib/csv-escape";

/** Filesystem-safe slug for the CSV filename. */
function fileSlug(s: string): string {
  return (s || "rsvp").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "rsvp";
}

export async function GET(req: Request, { params }: RouteParams) {
  const route = "GET /events/[eventId]/rsvp-campaigns/[campaignId]/invites";
  try {
    const [session, { eventId, campaignId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // H2: this GET returns each invitee's `token` — which IS the impersonation
    // credential. Anyone holding it can POST the PUBLIC rsvp/[token] endpoint
    // with no login and rewrite a named professor's attendance, guest count and
    // dietary note. It also returns the confidential VIP guest list (names,
    // emails, dietary requirements).
    //
    // The route had NO denyReviewer and hand-rolled `organizationId!` instead of
    // buildEventAccessWhere, so three org-ATTACHED populations could read it:
    // MEMBER (the read-only sponsor-side observer), ONSITE (org-scoped here, so
    // a desk temp assigned to Event A could pull Event B's roster — the July-7
    // cross-event class), and an internal-domain REGISTRANT (an attendee
    // account). denyReviewer blocks all three; loadRsvpEvent uses the
    // assignment-aware lookup the rest of the codebase uses.
    //
    // The token stays in the payload — the console's copy-link button needs it —
    // but only the roles that actually run the RSVP can see it.
    const denied = denyReviewer(session, { route: "events/[eventId]/rsvp-campaigns/[campaignId]/invites:GET" });
    if (denied) return denied;

    const event = await loadRsvpEvent(session.user, eventId);
    if (!event) {
      return apiErrorResponse(404, "Event not found", { route, eventId, userId: session.user.id });
    }

    // Resource-org lane for the swept RsvpItem/RsvpInvite reads below.
    return await runWithTenant(event.organizationId, async () => {
      const campaign = await loadRsvpCampaign(campaignId, eventId);
      if (!campaign) {
        return apiErrorResponse(404, "RSVP not found", {
          route, eventId, campaignId, userId: session.user.id,
        });
      }

      const [items, invites] = await Promise.all([
        db.rsvpItem.findMany({
          where: { campaignId },
          orderBy: [{ sortOrder: "asc" }, { startsAt: "asc" }],
          // B2: this is the ONLY place the console gets its items from. The
          // select used to be `{ id, name, dinnerAt }`, so location /
          // description / rsvpDeadline arrived as `undefined`, the edit dialog
          // rendered them blank, and saving PUT them back as ""/null — which
          // the PUT reads as an explicit CLEAR. Editing a typo in an item's
          // name therefore WIPED its venue, description and RSVP deadline.
          select: {
            id: true,
            name: true,
            startsAt: true,
            location: true,
            description: true,
            rsvpDeadline: true,
            sortOrder: true,
            isActive: true,
          },
        }),
        db.rsvpInvite.findMany({
          where: { campaignId },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            inviteeName: true,
            inviteeEmail: true,
            token: true,
            dietary: true,
            status: true,
            respondedAt: true,
            responses: { select: { itemId: true, attending: true, guestCount: true } },
          },
        }),
      ]);

      const headcounts = computeItemHeadcounts(items, invites);

      const url = new URL(req.url);
      if (url.searchParams.get("export") === "csv") {
        // L3: a bulk PII extraction (every invitee's name, email, dietary note)
        // used to leave no trace at all — unlike the survey export, which logs a
        // rowCount. If a VIP guest list leaks, this is the only record of who
        // pulled it and when.
        apiLogger.info(
          { eventId, campaignId, userId: session.user.id, rowCount: invites.length },
          "rsvp-invites:csv-exported",
        );
        const header = [
          "Name",
          "Email",
          "Status",
          "Responded At",
          ...(campaign.collectDietary ? ["Dietary"] : []),
          ...items.map((i) => i.name),
          ...(campaign.allowGuests ? items.map((i) => `${i.name} guests`) : []),
        ];
        const rows = invites.map((inv) => {
          const byItem = new Map(inv.responses.map((r) => [r.itemId, r]));
          return [
            inv.inviteeName,
            inv.inviteeEmail,
            inv.status,
            inv.respondedAt ? inv.respondedAt.toISOString() : "",
            ...(campaign.collectDietary ? [inv.dietary ?? ""] : []),
            ...items.map((i) => (byItem.get(i.id)?.attending ? "Yes" : "No")),
            ...(campaign.allowGuests
              ? items.map((i) => String(byItem.get(i.id)?.guestCount ?? 0))
              : []),
          ];
        });
        const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
        // VIP roster (names, emails, dietary) — durable audit, not just the
        // pino line above.
        recordExport(req, {
          entityType: "RsvpInvite",
          eventId,
          organizationId: session.user.organizationId,
          userId: session.user.id,
          role: session.user.role,
          rowCount: invites.length,
          format: "csv",
        });
        return new NextResponse(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="rsvp-${fileSlug(campaign.name)}.csv"`,
          },
        });
      }

      return NextResponse.json({ campaign, items, invites, headcounts });
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-invites:list-failed");
    return NextResponse.json({ error: "Failed to load RSVP roster" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  const route = "POST /events/[eventId]/rsvp-campaigns/[campaignId]/invites";
  try {
    const [session, { eventId, campaignId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route: "events/[eventId]/rsvp-campaigns/[campaignId]/invites:POST" });
    if (denied) return denied;

    const limit = checkRateLimit({
      key: `rsvp-invites-add:${eventId}`,
      limit: 30,
      windowMs: 3600_000,
    });
    if (!limit.allowed) {
      return rateLimited(limit, { route, eventId, campaignId, userId: session.user.id });
    }

    const parsed = rsvpInviteBulkSchema.safeParse(body);
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route, eventId, campaignId, userId: session.user.id });
    }

    const event = await loadRsvpEvent(session.user, eventId);
    if (!event) {
      return apiErrorResponse(404, "Event not found", { route, eventId, userId: session.user.id });
    }

    // De-dup within the payload + against already-invited emails.
    const seen = new Set<string>();
    const deduped = parsed.data.invitees.filter((i) => {
      const email = normalizeRsvpEmail(i.email);
      if (seen.has(email)) return false;
      seen.add(email);
      return true;
    });

    // Resource-org lane for the swept RsvpInvite existing-read + createMany.
    return await runWithTenant(event.organizationId, async () => {
      const campaign = await loadRsvpCampaign(campaignId, eventId);
      if (!campaign) {
        return apiErrorResponse(404, "RSVP not found", {
          route, eventId, campaignId, userId: session.user.id,
        });
      }

      // Scoped to the CAMPAIGN, not the event: the same person may already be
      // invited to a different RSVP on this event, and that must not skip them
      // here. This is the whole point of the campaign layer.
      const existing = await db.rsvpInvite.findMany({
        where: { campaignId, inviteeEmail: { in: [...seen] } },
        select: { inviteeEmail: true },
      });
      const already = new Set(existing.map((e) => e.inviteeEmail));

      const toCreate = deduped.filter((i) => !already.has(normalizeRsvpEmail(i.email)));
      let created = 0;
      if (toCreate.length > 0) {
        // Read the DB's actual insert count — `skipDuplicates` silently drops any
        // row that lost a race to a concurrent add (unique on campaignId+email),
        // so `toCreate.length` would over-report. This is the honest number.
        const result = await db.rsvpInvite.createMany({
          data: toCreate.map((i) => ({
            campaignId,
            eventId: campaign.eventId,
            organizationId: event.organizationId,
            token: generateRsvpToken(),
            inviteeName: i.name.trim(),
            inviteeEmail: normalizeRsvpEmail(i.email),
            registrationId: i.registrationId || null,
            speakerId: i.speakerId || null,
          })),
          skipDuplicates: true,
        });
        created = result.count;
      }

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "CREATE",
            entityType: "RSVP_INVITE",
            entityId: `bulk:${created}`,
            changes: { campaignId, created, skipped: deduped.length - created, bulk: true },
          },
        })
        .catch((err) => apiLogger.error({ err }, "rsvp-invites:audit-failed"));

      return NextResponse.json(
        { created, skipped: deduped.length - created },
        { status: 201 },
      );
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-invites:add-failed");
    return NextResponse.json({ error: "Failed to add invitees" }, { status: 500 });
  }
}
