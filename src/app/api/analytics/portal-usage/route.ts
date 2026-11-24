/**
 * Who uses the attendee portal (Nov 24, 2026): the Attendee portal card on the
 * app-wide Analytics page.
 *
 *   GET /api/analytics/portal-usage
 *
 * The events a person may read analytics for (`analytics.read`, as the
 * traffic route), and the portal accounts linked to them. Counts only, nothing personal; the rule
 * is src/lib/portal-usage.ts. Staff only: an attendee account never reads it.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { requireOrgId } from "@/lib/require-org";
import { staffAnalyticsEventWhere } from "@/lib/permissions/page-event-where";
import { runWithTenant } from "@/lib/tenant-context";
import { getPortalUsage } from "@/lib/portal-usage";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const orgGuard = requireOrgId(session, { route: "analytics:portal-usage" });
    if ("error" in orgGuard) return orgGuard.error;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `analytics-portal-usage:${session.user.id}`,
      limit: 120,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: session.user.id }, "analytics:portal-usage-rate-limited");
      return NextResponse.json(
        { error: "Too many requests", retryAfterSeconds, limit: 120, windowSeconds: 3600 },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    // analytics.read WITHOUT the linked-role allowance hubEventWhere grants (review
    // of 85a9b8ce3): an internal-domain registrant has an organisation too, and must
    // never count the attendees of the events it is registered at. It sees no events.
    const where = staffAnalyticsEventWhere(session, "analytics:portal-usage");
    const usage = await runWithTenant(orgGuard.orgId, async () => {
      const events = await db.event.findMany({ where, select: { id: true, settings: true } });
      return { eventsInScope: events.length, ...(await getPortalUsage(events)) };
    });
    const response = NextResponse.json(usage);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (err) {
    apiLogger.error({ err }, "analytics:portal-usage-failed");
    return NextResponse.json({ error: "Failed to load portal usage" }, { status: 500 });
  }
}
