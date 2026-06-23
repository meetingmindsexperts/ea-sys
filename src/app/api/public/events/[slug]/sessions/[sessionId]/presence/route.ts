import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

const ORG_STAFF_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER"]);

const presenceSchema = z.object({ phase: z.enum(["lobby", "joined"]) });

/**
 * Webinar presence heartbeat. The lobby/live page POSTs this every ~20-25s
 * while open so organizers can see who's in the lobby / joined in real time.
 *
 * Tracks OUR page presence (registrant has the page open), NOT actual Zoom
 * viewing — the authoritative post-event attendance is ZoomAttendance. Org
 * staff (QA viewers) are intentionally NOT recorded.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [authSession, { slug, sessionId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => ({})),
    ]);

    if (!authSession?.user) {
      return NextResponse.json({ error: "Sign in required", code: "UNAUTHENTICATED" }, { status: 401 });
    }

    // Rate-limit per user (auth is required anyway) — avoids shared-NAT throttling
    // and is generous: a 90-min webinar at a 25s beat ≈ 220 beats.
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `presence:${authSession.user.id}`,
      limit: 400,
      windowMs: 3600_000,
    });
    if (!allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const parsed = presenceSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten() }, "presence:validation-failed");
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }
    const phase = parsed.data.phase;

    const event = await db.event.findFirst({
      where: { slug, status: { in: ["DRAFT", "PUBLISHED", "LIVE"] } },
      select: { id: true, organizationId: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Org staff (host/QA testing) have no registration → don't pollute the
    // live roster or set webinarFirstJoinedAt.
    const isOrgStaff =
      ORG_STAFF_ROLES.has(authSession.user.role ?? "") &&
      authSession.user.organizationId === event.organizationId;
    if (isOrgStaff) {
      return NextResponse.json({ ok: true, tracked: false });
    }

    // Must be a registered (non-cancelled) attendee of this event.
    const registration = await db.registration.findFirst({
      where: { eventId: event.id, userId: authSession.user.id, status: { not: "CANCELLED" } },
      select: { id: true },
    });
    if (!registration) {
      return NextResponse.json({ error: "Not registered", code: "NOT_REGISTERED" }, { status: 403 });
    }

    // Session must belong to this event (defense against cross-event writes).
    const sessionRow = await db.eventSession.findFirst({
      where: { id: sessionId, eventId: event.id },
      select: { id: true },
    });
    if (!sessionRow) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const now = new Date();

    // Read the current phase to preserve "escalate lobby→joined only, never
    // downgrade joined→lobby". The WRITE is an upsert (INSERT … ON CONFLICT) so
    // concurrent first-beats from two tabs can't collide on the unique key
    // (no P2002), and there is NO interactive transaction holding a pooled
    // connection — critical at 5k attendees on the shared connection pool.
    const existing = await db.webinarPresence.findUnique({
      where: { sessionId_registrationId: { sessionId, registrationId: registration.id } },
      select: { phase: true },
    });

    await db.webinarPresence.upsert({
      where: { sessionId_registrationId: { sessionId, registrationId: registration.id } },
      create: {
        eventId: event.id,
        sessionId,
        registrationId: registration.id,
        phase,
        firstJoinedAt: now,
        lastSeenAt: now,
        joinCount: 1,
      },
      update: {
        lastSeenAt: now,
        // Only escalate on an existing lobby row beating "joined"; the create
        // branch already sets the phase for a brand-new row.
        ...(existing && phase === "joined" && existing.phase !== "joined"
          ? { phase: "joined", joinCount: { increment: 1 } }
          : {}),
      },
    });

    // Durable write-once "Joined" marker — only on the FIRST beat for this
    // session+registration. The WHERE is idempotent, but gating on !existing
    // avoids a needless write every ~30s for the whole webinar.
    if (!existing) {
      await db.registration.updateMany({
        where: { id: registration.id, webinarFirstJoinedAt: null },
        data: { webinarFirstJoinedAt: now },
      });
    }

    return NextResponse.json({ ok: true, tracked: true });
  } catch (error) {
    apiLogger.error({ err: error }, "presence:heartbeat-failed");
    return NextResponse.json({ error: "Failed to record presence" }, { status: 500 });
  }
}
