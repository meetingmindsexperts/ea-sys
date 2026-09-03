/**
 * Speaker activity timeline — merges the speaker's own audit/email/certificate
 * activity with the linked registration's, newest-first. Logic lives in the
 * shared builder (src/lib/activity-feed.ts) so the registration route produces
 * an identical feed from the other anchor.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { apiLogger } from "@/lib/logger";
import { buildSpeakerActivity } from "@/lib/activity-feed";
import { canViewFinance } from "@/lib/finance-visibility";
import { canManageReimbursements } from "@/lib/reimbursement/constants";
import { denyReviewer, REGISTRATION_DESK_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";

interface RouteParams {
  params: Promise<{ eventId: string; speakerId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, speakerId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // The activity feed exposes the speaker's audit trail + email history —
    // team-only (MEMBER/ONSITE included; REVIEWER/SUBMITTER/REGISTRANT are
    // org-null, so an org ternary here would drop the org filter entirely
    // and open a cross-tenant read).
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW, route: "events/[eventId]/speakers/[speakerId]/activity:GET" });
    if (denied) {
      apiLogger.warn({
        msg: "speaker-activity:role-denied",
        eventId,
        speakerId,
        userId: session.user.id,
        role: session.user.role,
      });
      return denied;
    }

    // Tenancy sweep: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    const orgId = session.user.organizationId;
    return await runWithTenantLane(orgId, { route: "speakers:activity", userId: session.user.id }, async () => {
    // Role-scoped event access (404 to avoid existence leak).
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({
        msg: "speaker-activity:event-not-found",
        eventId,
        userId: session.user.id,
        role: session.user.role,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const speaker = await db.speaker.findFirst({
      where: { id: speakerId, eventId },
      select: { id: true, email: true, sourceRegistrationId: true },
    });
    if (!speaker) {
      return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
    }

    const { items, linked } = await buildSpeakerActivity(
      eventId,
      speaker,
      session.user.organizationId,
      canViewFinance(session.user.role),
      canManageReimbursements(session.user.role),
    );
    return NextResponse.json({ items, linked });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error loading speaker activity timeline" });
    return NextResponse.json({ error: "Failed to load activity" }, { status: 500 });
  }
}
