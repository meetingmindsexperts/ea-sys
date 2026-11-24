/**
 * Public-site traffic across the organisation's events (Sep 25, 2026): the
 * app-wide Analytics page.
 *
 *   GET /api/analytics/traffic?days=30
 *
 * Which events count is `staffAnalyticsEventWhere` (`analytics.read`, staff
 * only): a role scoped to some events sees only those, a role with no events
 * (CRM, HR) gets an empty page rather than a refusal, and an attendee account
 * gets no events. There is
 * no finance data and nothing personal here: counts of cookieless page views
 * and of public-form registrations.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { requireOrgId } from "@/lib/require-org";
import { staffAnalyticsEventWhere } from "@/lib/permissions/page-event-where";
import { getOrgTraffic } from "@/analytics/store/org-traffic";
import { runWithTenant } from "@/lib/tenant-context";

// Same per-user bound as the per-event card: the read is capped and indexed,
// but nobody needs it hundreds of times an hour.
const RATE_LIMIT = 120;
const RATE_WINDOW_S = 3600;

/** The windows the page offers; an arbitrary number would let one request scan a year. */
const ALLOWED_DAYS = [7, 30, 90, 365] as const;
const querySchema = z.object({
  days: z.coerce
    .number()
    .refine((d) => (ALLOWED_DAYS as readonly number[]).includes(d), { message: "days must be 7, 30, 90 or 365" })
    .default(30),
});

/** The time zone most of these events use, so a day means the organiser's day. */
function commonTimeZone(events: { timezone: string | null }[]): string {
  const counts = new Map<string, number>();
  for (const e of events) if (e.timezone) counts.set(e.timezone, (counts.get(e.timezone) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "UTC";
}

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const orgGuard = requireOrgId(session, { route: "analytics:traffic" });
    if ("error" in orgGuard) return orgGuard.error;

    const parsed = querySchema.safeParse({ days: new URL(req.url).searchParams.get("days") ?? undefined });
    if (!parsed.success) {
      apiLogger.warn({ userId: session.user.id, errors: parsed.error.flatten() }, "analytics:org-traffic-invalid-range");
      return NextResponse.json({ error: "Invalid range", code: "INVALID_RANGE", allowed: ALLOWED_DAYS }, { status: 400 });
    }
    const days = parsed.data.days;

    // Same per-user bound as the per-event card: the read is capped and
    // indexed, but nobody needs it hundreds of times an hour.
    const rl = checkRateLimit({ key: `analytics-org-traffic:${session.user.id}`, limit: RATE_LIMIT, windowMs: RATE_WINDOW_S * 1000 });
    if (!rl.allowed) {
      return rateLimited(rl, { route: "analytics:org-traffic", userId: session.user.id, limit: RATE_LIMIT, windowSeconds: RATE_WINDOW_S });
    }

    // The events whose analytics this person may read (was the manage scoping),
    // read inside the organisation's lane. Staff only: an internal-domain
    // registrant has an organisation too, and gets no events here rather than
    // the traffic of the events it is registered at (review of 85a9b8ce3).
    const where = staffAnalyticsEventWhere(session, "analytics:traffic");
    const events = await runWithTenant(orgGuard.orgId, () =>
      db.event.findMany({ where, select: { id: true, name: true, slug: true, startDate: true, timezone: true } }),
    );

    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 3600_000);
    const traffic = await getOrgTraffic({
      organizationId: orgGuard.orgId,
      events,
      from,
      to,
      timeZone: commonTimeZone(events),
    });

    return NextResponse.json({ range: { days, from: from.toISOString(), to: to.toISOString() }, eventsInScope: events.length, ...traffic });
  } catch (err) {
    apiLogger.error({ err }, "analytics:org-traffic-failed");
    return NextResponse.json({ error: "Failed to load traffic" }, { status: 500 });
  }
}
