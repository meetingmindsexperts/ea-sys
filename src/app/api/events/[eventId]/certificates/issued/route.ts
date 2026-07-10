/**
 * GET /api/events/[eventId]/certificates/issued
 *   ?registrationId=<id>   OR  ?speakerId=<id>
 *
 * Lists issued certificates for one recipient (registration OR speaker)
 * so the detail-sheet IssuedCertificatesCard can render a per-recipient
 * activity table with Download + Resend per row.
 *
 * Exactly one of registrationId / speakerId is required. Returns rows
 * scoped to this event + that recipient AND the recipient's linked
 * counterpart (a speaker's companion registration, or a registration's
 * linked speaker), newest-first — so the card shows the person's FULL cert
 * set regardless of which facet each cert was issued against (ATTENDANCE →
 * registration, APPRECIATION → speaker). Counterpart resolution matches the
 * activity feed (pointer via sourceRegistrationId, else email).
 *
 * Auth: ADMIN / ORGANIZER (denyReviewer). Org-bound via the event.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { buildPersonCertificateWhere } from "@/lib/certificates/bundle";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({
        msg: "cert-issued-list:no-org",
        userId: session.user.id,
        eventId,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(req.url);
    const registrationId = url.searchParams.get("registrationId");
    const speakerId = url.searchParams.get("speakerId");

    // Exactly one of the two ids must be set — the card is per-recipient.
    if (!registrationId && !speakerId) {
      return NextResponse.json(
        { error: "Either registrationId or speakerId is required" },
        { status: 400 },
      );
    }
    if (registrationId && speakerId) {
      return NextResponse.json(
        { error: "Provide registrationId OR speakerId, not both" },
        { status: 400 },
      );
    }

    // Bind event to org first (404 on cross-tenant — non-enumeration).
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId },
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({
        msg: "cert-issued-list:event-not-found",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Build the recipient filter. A person can hold certs on BOTH facets:
    // ATTENDANCE certs land on the registration, APPRECIATION on the speaker.
    // So when asked for one facet, also fold in the linked counterpart's certs
    // (same person) — shared helper so this list and the resend-bundle route
    // agree on "the same person's" cert set.
    const { where } = await buildPersonCertificateWhere(eventId, registrationId, speakerId);

    const certificates = await db.issuedCertificate.findMany({
      where,
      orderBy: { issuedAt: "desc" },
      select: {
        id: true,
        type: true,
        serial: true,
        pdfUrl: true,
        issuedAt: true,
        lastResentAt: true,
        resendCount: true,
        lastReissuedAt: true,
        reissueCount: true,
        revokedAt: true,
        revocationReason: true,
        certificateTemplate: { select: { id: true, name: true } },
        // Pulled from the linked run item so the card can show
        // "first sent on …" alongside "last resent on …".
        issueRunItem: {
          select: {
            emailedAt: true,
            errorPhase: true,
            errorMessage: true,
          },
        },
      },
    });

    return NextResponse.json({ certificates });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-issued-list:failed", eventId });
    return NextResponse.json(
      { error: "Failed to load certificates" },
      { status: 500 },
    );
  }
}
