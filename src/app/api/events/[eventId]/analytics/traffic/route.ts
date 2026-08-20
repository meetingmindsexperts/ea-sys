/**
 * Public-page traffic for one event.
 *
 *   GET /api/events/[eventId]/analytics/traffic?days=30
 *
 * Served alongside the existing analytics route rather than inside it: this
 * reads a different table, answers a different question, and is the half that
 * can be empty for weeks after deploy while the other is populated from day
 * one. Folding it in would have made a slow or missing traffic query able to
 * take the registration figures down with it.
 *
 * Access is exactly the existing Analytics page's: whoever can see an event's
 * registrations can see how many people looked at its public pages. There is no
 * finance data here and nothing personal, so no narrower predicate applies.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getEventTraffic } from "@/analytics/store/event-traffic";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

/** Windows the UI offers. An arbitrary number would let one request scan a year. */
const ALLOWED_DAYS = [7, 30, 90, 365] as const;
const DEFAULT_DAYS = 30;

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const raw = new URL(req.url).searchParams.get("days");
    const requested = raw === null ? DEFAULT_DAYS : Number(raw);
    if (!ALLOWED_DAYS.includes(requested as (typeof ALLOWED_DAYS)[number])) {
      // Refused rather than silently clamped: a caller asking for 5000 days
      // should be told, not handed 30 and left to believe it got what it asked
      // for. Same reasoning as the INVALID_FILTER guards elsewhere.
      apiLogger.warn({ userId: session.user.id, eventId, requested: raw }, "analytics-traffic:invalid-range");
      return NextResponse.json(
        { error: "Invalid range", code: "INVALID_RANGE", allowed: ALLOWED_DAYS },
        { status: 400 },
      );
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true, timezone: true },
    });
    if (!event) {
      apiLogger.warn({ userId: session.user.id, eventId }, "analytics-traffic:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Cheap per-user bound. The query is capped and indexed, but this page is
    // reachable by anyone who can see the event and there is no reason for one
    // person to run it hundreds of times an hour.
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `analytics-traffic:${session.user.id}`,
      limit: 120,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: session.user.id, eventId }, "analytics-traffic:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const to = new Date();
    const from = new Date(to.getTime() - requested * 24 * 3600_000);

    const traffic = await getEventTraffic({
      eventId: event.id,
      organizationId: event.organizationId,
      from,
      to,
      // Days are bucketed in the EVENT's timezone, so an evening in Dubai does
      // not land on tomorrow for a viewer sitting in London.
      timeZone: event.timezone || "UTC",
    });

    return NextResponse.json({
      range: { days: requested, from: from.toISOString(), to: to.toISOString() },
      ...traffic,
    });
  } catch (err) {
    apiLogger.error({ err }, "analytics-traffic:failed");
    return NextResponse.json({ error: "Failed to load traffic" }, { status: 500 });
  }
}
