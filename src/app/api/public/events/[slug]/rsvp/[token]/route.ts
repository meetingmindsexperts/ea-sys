/**
 * Public RSVP — tokenized load + submit (no login).
 *
 *   GET  /api/public/events/[slug]/rsvp/[token]
 *     → validates the token, asserts the invite is on the URL's event,
 *       returns event branding + read-only prefill (name/email/dietary) +
 *       the invite's CAMPAIGN config + that campaign's active items with this
 *       invitee's current selections and a per-item `closed` flag.
 *
 *   POST /api/public/events/[slug]/rsvp/[token]
 *     → body { dietary?, items: [{ itemId, attending, guestCount }] }
 *     → upserts one RsvpResponse per still-open item, marks the invite
 *       RESPONDED, saves the dietary note — all in one transaction.
 *       Re-submittable until deadlines (upsert), so the invitee can change
 *       their mind. Closed items are ignored (not an error).
 *
 * A token belongs to ONE campaign, so this page only ever shows that
 * campaign's items — a person on both the dinner and the workshop list holds
 * two tokens and sees each ask separately.
 *
 * Token lookup is by the unique `token` column, then event-slug asserted.
 * Rate-limited per IP. Every branch logs `{ slug, stage }`.
 * Docs: docs/RSVP.md.
 */
import { NextResponse } from "next/server";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { eventMatchesRequestTenant, publicEventWhere } from "@/lib/public-event";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rsvpSubmitSchema, violatesSelectionMode } from "@/lib/rsvp/rsvp";

type RouteParams = { params: Promise<{ slug: string; token: string }> };

const submitBodySchema = rsvpSubmitSchema.omit({ token: true });

/**
 * Effective close for an item (review R2 M1): the explicit rsvpDeadline
 * wins; an item with NO deadline closes when the item starts — the
 * deadline field is optional in the console, so "no deadline" must not
 * mean "the roster is editable forever, including after the gala".
 */
function isItemOpen(d: { rsvpDeadline: Date | null; startsAt: Date }, now: number): boolean {
  return (d.rsvpDeadline ?? d.startsAt).getTime() >= now;
}

/** Load the invite by token and assert it belongs to the URL's event + tenant. */
async function loadInviteForSlug(req: Request, slug: string, token: string) {
  const invite = await db.rsvpInvite.findUnique({
    where: { token },
    select: {
      id: true,
      eventId: true,
      campaignId: true,
      inviteeName: true,
      inviteeEmail: true,
      dietary: true,
      status: true,
      campaign: {
        select: {
          id: true,
          name: true,
          description: true,
          selectionMode: true,
          allowGuests: true,
          collectDietary: true,
          isActive: true,
        },
      },
      event: {
        select: {
          slug: true,
          organizationId: true,
          name: true,
          bannerImage: true,
          bannerImageMobile: true,
          startDate: true,
          endDate: true,
          timezone: true,
        },
      },
      responses: { select: { itemId: true, attending: true, guestCount: true } },
    },
  });
  if (!invite || invite.event.slug !== slug) return null;
  // Defense-in-depth: a token minted for tenant A must not render on tenant
  // B's domain (tautologically true on master's unscoped resolution).
  if (!(await eventMatchesRequestTenant(req, invite.event.organizationId))) {
    apiLogger.warn({ slug, eventId: invite.eventId }, "rsvp-public:tenant-mismatch");
    return null;
  }
  return invite;
}

/**
 * Resolve the tenant org from the (un-swept) Event by request host + slug. The
 * swept RsvpInvite token lookup below must run inside runWithTenant(this org):
 * under RLS a token read with NO tenant context fail-closes to null, so every
 * link would look invalid. publicEventWhere binds the host's org (unscoped /
 * behavior-preserving on master); the invite's own slug + tenant asserts inside
 * loadInviteForSlug stay as defense-in-depth. Returns null when the slug maps
 * to no accessible event on this host.
 */
async function resolveEventOrg(req: Request, slug: string): Promise<string | null> {
  const event = await db.event.findFirst({
    where: await publicEventWhere(req, slug),
    select: { organizationId: true },
  });
  return event?.organizationId ?? null;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, token } = await params;
    const ip = getClientIp(req);
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `rsvp-load:${ip}`,
      limit: 120,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ slug, ip, stage: "load" }, "rsvp-public:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const org = await resolveEventOrg(req, slug);
    if (!org) {
      apiLogger.warn({ slug, stage: "load" }, "rsvp-public:invalid-token");
      return NextResponse.json({ error: "This RSVP link is invalid." }, { status: 404 });
    }

    return await runWithTenant(org, async () => {
      const invite = await loadInviteForSlug(req, slug, token);
      if (!invite) {
        apiLogger.warn({ slug, stage: "load" }, "rsvp-public:invalid-token");
        return NextResponse.json({ error: "This RSVP link is invalid." }, { status: 404 });
      }

      // Scoped to the invite's CAMPAIGN — this link must never surface another
      // audience's items (the reason the campaign layer exists).
      const items = await db.rsvpItem.findMany({
        where: { campaignId: invite.campaignId, isActive: true },
        orderBy: [{ sortOrder: "asc" }, { startsAt: "asc" }],
        select: {
          id: true,
          name: true,
          startsAt: true,
          location: true,
          description: true,
          rsvpDeadline: true,
        },
      });
      const now = Date.now();
      const selection = new Map(invite.responses.map((r) => [r.itemId, r]));

      return NextResponse.json({
        event: invite.event,
        campaign: invite.campaign,
        invitee: {
          name: invite.inviteeName,
          email: invite.inviteeEmail,
          dietary: invite.dietary ?? "",
        },
        status: invite.status,
        items: items.map((d) => ({
          id: d.id,
          name: d.name,
          startsAt: d.startsAt,
          location: d.location,
          description: d.description,
          rsvpDeadline: d.rsvpDeadline,
          closed: !isItemOpen(d, now),
          attending: selection.get(d.id)?.attending ?? false,
          guestCount: selection.get(d.id)?.guestCount ?? 0,
        })),
      });
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-public:load-failed");
    return NextResponse.json({ error: "Failed to load RSVP" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug, token } = await params;
    const ip = getClientIp(req);
    // Two buckets (review R2 L11): a generous per-IP ceiling so a committee
    // room behind one hotel NAT ("please RSVP now") isn't false-blocked, plus
    // a tight per-token bucket so a single link can't spam submits.
    const ipLimit = checkRateLimit({
      key: `rsvp-submit:${ip}`,
      limit: 120,
      windowMs: 3600_000,
    });
    const tokenLimit = checkRateLimit({
      key: `rsvp-submit-token:${token.slice(0, 16)}`,
      limit: 20,
      windowMs: 3600_000,
    });
    if (!ipLimit.allowed || !tokenLimit.allowed) {
      const retryAfterSeconds = Math.max(
        ipLimit.retryAfterSeconds ?? 0,
        tokenLimit.retryAfterSeconds ?? 0,
      );
      apiLogger.warn({ slug, ip, stage: "submit" }, "rsvp-public:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const body = await req.json().catch(() => null);
    const parsed = submitBodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ slug, stage: "validate", errors: parsed.error.flatten() }, "rsvp-public:submit-invalid");
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const org = await resolveEventOrg(req, slug);
    if (!org) {
      apiLogger.warn({ slug, stage: "submit-load" }, "rsvp-public:invalid-token");
      return NextResponse.json({ error: "This RSVP link is invalid." }, { status: 404 });
    }

    return await runWithTenant(org, async () => {
      const invite = await loadInviteForSlug(req, slug, token);
      if (!invite) {
        apiLogger.warn({ slug, stage: "submit-load" }, "rsvp-public:invalid-token");
        return NextResponse.json({ error: "This RSVP link is invalid." }, { status: 404 });
      }

      // Only accept responses for the CAMPAIGN's active, still-open items.
      // "Open" = before the explicit rsvpDeadline, else before the item itself
      // starts (review R2 M1 — a deadline-less item must not stay editable
      // after the gala).
      const openItems = await db.rsvpItem.findMany({
        where: { campaignId: invite.campaignId, isActive: true },
        select: { id: true, rsvpDeadline: true, startsAt: true },
      });
      const now = Date.now();
      const openIds = new Set(openItems.filter((d) => isItemOpen(d, now)).map((d) => d.id));
      const accepted = parsed.data.items.filter((d) => openIds.has(d.itemId));
      // R2 M2: an answer for an item that closed between form-load and submit
      // must not vanish behind a 200 — report the ids so the form can say so.
      const ignoredItemIds = parsed.data.items
        .filter((d) => !openIds.has(d.itemId))
        .map((d) => d.itemId);

      if (openIds.size === 0) {
        apiLogger.warn({ slug, inviteId: invite.id, stage: "closed" }, "rsvp-public:all-closed");
        return NextResponse.json({ error: "RSVP is now closed for this event." }, { status: 400 });
      }
      // R2 M3: a payload that addresses ZERO open items is a stale form
      // (loaded before a new item appeared / after every submitted one
      // closed) — running the replace-all would wipe answers made from a
      // fresher tab, create nothing, and stamp RESPONDED. Reject instead.
      // A legitimate decline-all is unaffected: the form submits an explicit
      // attending:false row for every open item, so accepted > 0.
      if (accepted.length === 0) {
        apiLogger.warn(
          { slug, inviteId: invite.id, ignoredItemIds, stage: "stale-form" },
          "rsvp-public:stale-form-rejected",
        );
        return NextResponse.json(
          {
            error:
              "This form is out of date — this RSVP's options have changed since you opened it. Please reload the page and submit again.",
            code: "STALE_FORM",
          },
          { status: 409 },
        );
      }

      const attendingRows = accepted.filter((d) => d.attending);

      // SINGLE mode is enforced HERE, not merely by the radio group: a crafted
      // POST naming two items must be a 400, never a silent first-wins.
      // Declining everything stays valid in both modes.
      if (violatesSelectionMode(invite.campaign.selectionMode, attendingRows.length)) {
        apiLogger.warn(
          { slug, inviteId: invite.id, attending: attendingRows.length, stage: "selection-mode" },
          "rsvp-public:single-mode-violation",
        );
        return NextResponse.json(
          {
            error: "You can only choose one option for this RSVP.",
            code: "SINGLE_SELECTION_ONLY",
          },
          { status: 400 },
        );
      }

      // Guests are a per-campaign switch. When it's off, a submitted count is
      // IGNORED (stored 0) rather than persisted — otherwise a crafted POST
      // would inflate a catering headcount for an RSVP that never asked.
      const guestFor = (n: number) => (invite.campaign.allowGuests ? n : 0);

      // Server-authoritative REPLACE-ALL over the OPEN items: the submit is the
      // invitee's complete intent for every open item, so we clear their open-
      // item responses and re-create only the ones they're attending. A partial
      // or crafted POST that omits a previously-attended (open) item therefore
      // can't leave ghost attendance. Closed items are left untouched (a
      // response captured before the deadline stays valid).
      //
      // tenantTransaction (not db.$transaction): the interactive tx opens its own
      // pooled backend session, so it must issue its own SET LOCAL app.current_org
      // — a plain $transaction inside the runWithTenant scope would run un-scoped
      // and fail-close under RLS. It reads the ALS store set by the wrap above.
      await tenantTransaction(async (tx) => {
        // Serialize concurrent submits for THIS invite (double-click / retry /
        // two tabs / direct API): a row lock makes each replace-all run cleanly
        // and last-write-wins, instead of two delete-then-insert transactions
        // racing on the (inviteId, itemId) unique index → P2002/500. The lock
        // is held for the interactive transaction's single backend session.
        await tx.$queryRaw`SELECT id FROM "RsvpInvite" WHERE id = ${invite.id} FOR UPDATE`;

        await tx.rsvpResponse.deleteMany({
          where: { inviteId: invite.id, itemId: { in: [...openIds] } },
        });
        if (attendingRows.length > 0) {
          await tx.rsvpResponse.createMany({
            data: attendingRows.map((d) => ({
              inviteId: invite.id,
              itemId: d.itemId,
              organizationId: org,
              attending: true,
              guestCount: guestFor(d.guestCount),
            })),
            skipDuplicates: true, // belt-and-suspenders behind the row lock
          });
        }
        await tx.rsvpInvite.update({
          where: { id: invite.id },
          data: {
            status: "RESPONDED",
            respondedAt: new Date(),
            // Only touch dietary when this campaign actually collects it — a
            // workshop submit must not blank the dietary note the same person
            // gave on the dinner RSVP (different invite, but the same rule
            // keeps a config flip from destroying an existing answer).
            ...(invite.campaign.collectDietary
              ? { dietary: parsed.data.dietary ? parsed.data.dietary.trim() : null }
              : {}),
          },
        });
      });

      // R2 M10: the replace-all destroys the previous answer, and an RSVP
      // drives paid catering headcounts — record before→after with the IP, the
      // same shape as the public speaker-agreement acceptance audit (the other
      // externally-meaningful token-based write). Fire-and-forget: an audit
      // blip must never fail a committed RSVP.
      db.auditLog
        .create({
          data: {
            eventId: invite.eventId,
            userId: null,
            action: "RESPOND",
            entityType: "RSVP_INVITE",
            entityId: invite.id,
            changes: {
              actor: "INVITEE",
              campaignId: invite.campaignId,
              before: invite.responses.map((r) => ({
                itemId: r.itemId,
                attending: r.attending,
                guestCount: r.guestCount,
              })),
              after: attendingRows.map((d) => ({
                itemId: d.itemId,
                attending: true,
                guestCount: guestFor(d.guestCount),
              })),
              ignoredItemIds,
              dietary: invite.campaign.collectDietary
                ? parsed.data.dietary
                  ? parsed.data.dietary.trim()
                  : null
                : undefined,
              ip,
            },
            ipAddress: ip,
          },
        })
        .catch((err) => apiLogger.error({ err, inviteId: invite.id }, "rsvp-public:audit-failed"));

      apiLogger.info(
        {
          slug,
          inviteId: invite.id,
          campaignId: invite.campaignId,
          items: accepted.length,
          ignored: ignoredItemIds.length,
        },
        "rsvp-public:submitted",
      );
      return NextResponse.json({ ok: true, ignoredItemIds });
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-public:submit-failed");
    return NextResponse.json({ error: "Failed to submit RSVP" }, { status: 500 });
  }
}
