import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { ensureSpeakerCompanionRegistration } from "@/lib/speaker-companion";

/**
 * POST — grant (or RE-grant) this speaker a complimentary companion
 * registration (the "attendee facet": comp Faculty registration → badge /
 * entry barcode / check-in / survey), by explicit organizer action.
 *
 * Model (owner decision, July 30 2026): self-signup (abstract submitters +
 * session proposers) auto-mints the comp registration at account creation, and
 * the organizer REVOKES per person when someone shouldn't attend free (cancel
 * the companion registration — the proposal sheet's Revoke button / the
 * registrations list). This route is the counterpart: re-grant a revoked
 * person, or recover a signup whose auto-provisioning hiccuped.
 *
 * Idempotent — delegates to ensureSpeakerCompanionRegistration:
 *   already linked                        → no-op (`already-linked`)
 *   same-email NON-CANCELLED registration → link it (`linked-by-email`)
 *   otherwise (incl. only-cancelled ones) → create a fresh comp Faculty
 *                                           companion (`created`)
 */

interface RouteParams {
  params: Promise<{ eventId: string; speakerId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, speakerId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Granting free entry is an organizer decision — ADMIN/ORGANIZER only
    // (default denyReviewer set: no MEMBER/ONSITE/REVIEWER/SUBMITTER/REGISTRANT).
    const denied = denyReviewer(session);
    if (denied) return denied;

    // Tenancy sweep: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    const orgId = session.user.organizationId ?? "";
    return await runWithTenant(orgId, async () => {
    const rate = checkRateLimit({
      key: `grant-companion:${session.user.id}`,
      limit: 60,
      windowMs: 60 * 60 * 1000,
    });
    if (!rate.allowed) {
      return rateLimited(rate, {
        route: "grant-companion",
        userId: session.user.id,
        eventId,
      });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({
        msg: "grant-companion:event-not-found",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const speaker = await db.speaker.findFirst({
      where: { id: speakerId, eventId },
      select: {
        id: true,
        eventId: true,
        email: true,
        firstName: true,
        lastName: true,
        title: true,
        additionalEmail: true,
        organization: true,
        jobTitle: true,
        phone: true,
        photo: true,
        city: true,
        state: true,
        zipCode: true,
        country: true,
        specialty: true,
        registrationType: true,
        role: true,
        sourceRegistrationId: true,
        sourceRegistration: { select: { status: true } },
      },
    });
    if (!speaker) {
      apiLogger.warn({
        msg: "grant-companion:speaker-not-found",
        eventId,
        speakerId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
    }

    // RE-grant after a revoke: the cancel keeps `sourceRegistrationId` pointing
    // at the CANCELLED row (audit/timeline continuity), which would make the
    // ensure helper short-circuit "already-linked" against a dead registration.
    // Treat a cancelled link as no link so the helper links a live same-email
    // registration or mints a fresh companion (and re-points the speaker).
    const { sourceRegistration, ...speakerInput } = speaker;
    const result = await ensureSpeakerCompanionRegistration({
      ...speakerInput,
      sourceRegistrationId:
        sourceRegistration?.status === "CANCELLED" ? null : speaker.sourceRegistrationId,
    });

    // Audit only real grants/links — an already-linked no-op writes nothing.
    if (result.status !== "already-linked") {
      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "COMPANION_GRANTED",
            entityType: "Speaker",
            entityId: speaker.id,
            changes: {
              registrationId: result.registrationId,
              outcome: result.status,
            },
            ipAddress: getClientIp(req),
          },
        })
        .catch((err) =>
          apiLogger.warn({ err, msg: "grant-companion:audit-failed", speakerId }),
        );
    }

    apiLogger.info({
      msg: "grant-companion:granted",
      eventId,
      speakerId,
      registrationId: result.registrationId,
      outcome: result.status,
      userId: session.user.id,
    });

    return NextResponse.json({
      ok: true,
      outcome: result.status,
      registrationId: result.registrationId,
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "grant-companion:failed" });
    return NextResponse.json({ error: "Failed to grant registration" }, { status: 500 });
  }
}
