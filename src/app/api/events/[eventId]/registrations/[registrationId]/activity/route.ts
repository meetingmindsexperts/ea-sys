/**
 * Registration activity timeline — merges the registration's own
 * audit/email/certificate activity with the linked speaker's (if this person is
 * also a speaker), newest-first. Same shared builder as the speaker route, so a
 * person who is both sees one consistent feed from either page.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildRegistrationActivity } from "@/lib/activity-feed";
import { canViewFinance } from "@/lib/finance-visibility";
import { denyReviewer, REGISTRATION_DESK_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, registrationId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // The activity feed exposes the person's audit trail + email history —
    // team-only (MEMBER/ONSITE included; REVIEWER/SUBMITTER/REGISTRANT are
    // org-null, so an org ternary here would drop the org filter entirely
    // and open a cross-tenant read).
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW });
    if (denied) {
      apiLogger.warn({
        msg: "registration-activity:role-denied",
        eventId,
        registrationId,
        userId: session.user.id,
        role: session.user.role,
      });
      return denied;
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({
        msg: "registration-activity:event-not-found",
        eventId,
        userId: session.user.id,
        role: session.user.role,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const registration = await db.registration.findFirst({
      where: { id: registrationId, eventId },
      select: { id: true, attendee: { select: { email: true } } },
    });
    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const { items, linked } = await buildRegistrationActivity(
      eventId,
      { id: registration.id, attendeeEmail: registration.attendee?.email ?? null },
      session.user.organizationId,
      canViewFinance(session.user.role),
    );
    return NextResponse.json({ items, linked });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error loading registration activity timeline" });
    return NextResponse.json({ error: "Failed to load activity" }, { status: 500 });
  }
}
