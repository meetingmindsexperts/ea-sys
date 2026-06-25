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

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, registrationId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        ...(session.user.organizationId ? { organizationId: session.user.organizationId } : {}),
      },
      select: { id: true },
    });
    if (!event) {
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
    );
    return NextResponse.json({ items, linked });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error loading registration activity timeline" });
    return NextResponse.json({ error: "Failed to load activity" }, { status: 500 });
  }
}
