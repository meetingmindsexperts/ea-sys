/**
 * Speaker activity timeline — merges the speaker's own audit/email/certificate
 * activity with the linked registration's, newest-first. Logic lives in the
 * shared builder (src/lib/activity-feed.ts) so the registration route produces
 * an identical feed from the other anchor.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildSpeakerActivity } from "@/lib/activity-feed";
import { canViewFinance } from "@/lib/finance-visibility";

interface RouteParams {
  params: Promise<{ eventId: string; speakerId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, speakerId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Org-scope the event (404 to avoid existence leak). Read-only — open to
    // any authenticated org member who can already view the speaker page.
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
    );
    return NextResponse.json({ items, linked });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error loading speaker activity timeline" });
    return NextResponse.json({ error: "Failed to load activity" }, { status: 500 });
  }
}
