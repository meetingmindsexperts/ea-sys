import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

type RouteParams = { params: Promise<{ eventId: string }> };

/**
 * GET /api/events/[eventId]/abstracts/my-profile
 *
 * Self-scoped read for the abstract-submitter landing page. Resolves the
 * caller's OWN Speaker record on this event (by `Speaker.userId === session
 * user`), so it's ownership-safe by construction — a submitter can only ever
 * see their own profile, their linked (companion / email-matched) registration,
 * and their own abstracts. View-only; there is no write counterpart here (the
 * general PUT + email-change routes handle edits).
 *
 * 404 when the caller has no speaker on this event (not a submitter here).
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const speaker = await db.speaker.findFirst({
      where: { eventId, userId: session.user.id },
      select: {
        id: true,
        title: true,
        role: true,
        firstName: true,
        lastName: true,
        email: true,
        additionalEmail: true,
        organization: true,
        jobTitle: true,
        phone: true,
        city: true,
        state: true,
        zipCode: true,
        country: true,
        specialty: true,
        customSpecialty: true,
        status: true,
        agreementAcceptedAt: true,
        // The "attendee facet" — the companion (or email-matched) registration
        // that backs this submitter's badge / entry barcode / check-in / survey.
        sourceRegistration: {
          select: {
            id: true,
            serialId: true,
            status: true,
            paymentStatus: true,
            attendanceMode: true,
            badgeType: true,
            qrCode: true,
            checkedInAt: true,
            surveyCompletedAt: true,
            createdSource: true,
            ticketType: { select: { name: true, isFaculty: true } },
          },
        },
        abstracts: {
          select: {
            id: true,
            title: true,
            status: true,
            presentationType: true,
            submittedAt: true,
            reviewedAt: true,
          },
          orderBy: { submittedAt: "desc" },
        },
      },
    });

    if (!speaker) {
      return NextResponse.json(
        { error: "No submitter profile found for this event", code: "NOT_A_SUBMITTER" },
        { status: 404 }
      );
    }

    return NextResponse.json(speaker);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching submitter profile" });
    return NextResponse.json({ error: "Failed to load your profile" }, { status: 500 });
  }
}
