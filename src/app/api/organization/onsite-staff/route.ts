import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";

/**
 * Org-level view that powers the Settings → Onsite Staff tab: every ONSITE
 * account in the org, each with the list of events it's assigned to (via
 * `Event.settings.onsiteUserIds`), plus the org's events to pick from.
 *
 * Assignment itself is written per-event through
 * `POST/DELETE /api/events/[eventId]/onsite-staff`; new accounts are created
 * via the existing `POST /api/organization/users` (role ONSITE). This route is
 * read-only. Guarded by `denyReviewer` (ADMIN / ORGANIZER / SUPER_ADMIN).
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    const orgId = session.user.organizationId;
    if (!orgId) {
      return NextResponse.json({ onsiteStaff: [], events: [] });
    }

    const [users, events] = await Promise.all([
      db.user.findMany({
        where: { organizationId: orgId, role: "ONSITE" },
        select: { id: true, firstName: true, lastName: true, email: true, emailVerified: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      }),
      db.event.findMany({
        where: { organizationId: orgId },
        select: { id: true, name: true, startDate: true, settings: true },
        orderBy: { startDate: "desc" },
      }),
    ]);

    // Map each ONSITE user to the events whose onsiteUserIds include them.
    const onsiteStaff = users.map((u) => ({
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      active: !!u.emailVerified,
      createdAt: u.createdAt,
      eventIds: events
        .filter((e) => (((e.settings as Record<string, unknown>)?.onsiteUserIds as string[]) ?? []).includes(u.id))
        .map((e) => e.id),
    }));

    return NextResponse.json({
      onsiteStaff,
      events: events.map((e) => ({ id: e.id, name: e.name, startDate: e.startDate })),
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error listing org onsite staff" });
    return NextResponse.json({ error: "Failed to list onsite staff" }, { status: 500 });
  }
}
