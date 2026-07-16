/**
 * Public Dinner RSVP — tokenized load + submit (no login).
 *
 *   GET  /api/public/events/[slug]/rsvp/[token]
 *     → validates the token, asserts the invite is on the URL's event,
 *       returns event branding + read-only prefill (name/email/dietary) +
 *       the event's active dinners with this invitee's current selections
 *       and a per-dinner `closed` flag (past its rsvpDeadline).
 *
 *   POST /api/public/events/[slug]/rsvp/[token]
 *     → body { dietary?, dinners: [{ dinnerId, attending, guestCount }] }
 *     → upserts one RsvpDinnerResponse per still-open dinner, marks the
 *       invite RESPONDED, saves the dietary note — all in one transaction.
 *       Re-submittable until deadlines (upsert), so the invitee can change
 *       their mind. Closed dinners are ignored (not an error).
 *
 * Token lookup is by the unique `token` column, then event-slug asserted.
 * Rate-limited per IP. Every branch logs `{ slug, stage }`.
 * Docs: docs/DINNER_RSVP.md.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rsvpSubmitSchema } from "@/lib/rsvp/rsvp";

type RouteParams = { params: Promise<{ slug: string; token: string }> };

const submitBodySchema = rsvpSubmitSchema.omit({ token: true });

/** Load the invite by token and assert it belongs to the URL's event. */
async function loadInviteForSlug(slug: string, token: string) {
  const invite = await db.rsvpInvite.findUnique({
    where: { token },
    select: {
      id: true,
      eventId: true,
      inviteeName: true,
      inviteeEmail: true,
      dietary: true,
      status: true,
      event: {
        select: {
          slug: true,
          name: true,
          bannerImage: true,
          bannerImageMobile: true,
          startDate: true,
          endDate: true,
          timezone: true,
        },
      },
      responses: { select: { dinnerId: true, attending: true, guestCount: true } },
    },
  });
  if (!invite || invite.event.slug !== slug) return null;
  return invite;
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

    const invite = await loadInviteForSlug(slug, token);
    if (!invite) {
      apiLogger.warn({ slug, stage: "load" }, "rsvp-public:invalid-token");
      return NextResponse.json({ error: "This RSVP link is invalid." }, { status: 404 });
    }

    const dinners = await db.rsvpDinner.findMany({
      where: { eventId: invite.eventId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { dinnerAt: "asc" }],
      select: { id: true, name: true, dinnerAt: true, location: true, description: true, rsvpDeadline: true },
    });
    const now = Date.now();
    const selection = new Map(invite.responses.map((r) => [r.dinnerId, r]));

    return NextResponse.json({
      event: invite.event,
      invitee: { name: invite.inviteeName, email: invite.inviteeEmail, dietary: invite.dietary ?? "" },
      status: invite.status,
      dinners: dinners.map((d) => ({
        id: d.id,
        name: d.name,
        dinnerAt: d.dinnerAt,
        location: d.location,
        description: d.description,
        rsvpDeadline: d.rsvpDeadline,
        closed: d.rsvpDeadline ? d.rsvpDeadline.getTime() < now : false,
        attending: selection.get(d.id)?.attending ?? false,
        guestCount: selection.get(d.id)?.guestCount ?? 0,
      })),
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
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `rsvp-submit:${ip}`,
      limit: 30,
      windowMs: 3600_000,
    });
    if (!allowed) {
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

    const invite = await loadInviteForSlug(slug, token);
    if (!invite) {
      apiLogger.warn({ slug, stage: "submit-load" }, "rsvp-public:invalid-token");
      return NextResponse.json({ error: "This RSVP link is invalid." }, { status: 404 });
    }

    // Only accept responses for the event's active, still-open dinners.
    const openDinners = await db.rsvpDinner.findMany({
      where: { eventId: invite.eventId, isActive: true },
      select: { id: true, rsvpDeadline: true },
    });
    const now = Date.now();
    const openIds = new Set(
      openDinners.filter((d) => !d.rsvpDeadline || d.rsvpDeadline.getTime() >= now).map((d) => d.id),
    );
    const accepted = parsed.data.dinners.filter((d) => openIds.has(d.dinnerId));

    if (accepted.length === 0 && openIds.size === 0) {
      apiLogger.warn({ slug, inviteId: invite.id, stage: "closed" }, "rsvp-public:all-closed");
      return NextResponse.json({ error: "RSVP is now closed for this event." }, { status: 400 });
    }

    // Server-authoritative REPLACE-ALL over the OPEN dinners: the submit is the
    // invitee's complete intent for every open dinner, so we clear their open-
    // dinner responses and re-create only the ones they're attending. A partial
    // or crafted POST that omits a previously-attended (open) dinner therefore
    // can't leave ghost attendance. Closed dinners are left untouched (a
    // response captured before the deadline stays valid).
    const attendingRows = accepted.filter((d) => d.attending);
    await db.$transaction(async (tx) => {
      // Serialize concurrent submits for THIS invite (double-click / retry /
      // two tabs / direct API): a row lock makes each replace-all run cleanly
      // and last-write-wins, instead of two delete-then-insert transactions
      // racing on the (inviteId, dinnerId) unique index → P2002/500. The lock
      // is held for the interactive transaction's single backend session.
      await tx.$queryRaw`SELECT id FROM "RsvpInvite" WHERE id = ${invite.id} FOR UPDATE`;

      await tx.rsvpDinnerResponse.deleteMany({
        where: { inviteId: invite.id, dinnerId: { in: [...openIds] } },
      });
      if (attendingRows.length > 0) {
        await tx.rsvpDinnerResponse.createMany({
          data: attendingRows.map((d) => ({
            inviteId: invite.id,
            dinnerId: d.dinnerId,
            attending: true,
            guestCount: d.guestCount,
          })),
          skipDuplicates: true, // belt-and-suspenders behind the row lock
        });
      }
      await tx.rsvpInvite.update({
        where: { id: invite.id },
        data: {
          status: "RESPONDED",
          respondedAt: new Date(),
          dietary: parsed.data.dietary ? parsed.data.dietary.trim() : null,
        },
      });
    });

    apiLogger.info(
      { slug, inviteId: invite.id, dinners: accepted.length },
      "rsvp-public:submitted",
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-public:submit-failed");
    return NextResponse.json({ error: "Failed to submit RSVP" }, { status: 500 });
  }
}
