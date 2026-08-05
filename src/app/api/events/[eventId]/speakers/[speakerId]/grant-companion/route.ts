import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { ensureSpeakerCompanionRegistration } from "@/lib/speaker-companion";
import {
  createRegistration,
  type RegistrationTitle,
  type RegistrationAttendeeRole,
} from "@/services/registration-service";

/**
 * POST — grant this speaker a registration by explicit organizer action, in
 * one of two modes (owner decision Aug 5, 2026 — session-proposal signups no
 * longer auto-mint anything; the organizer decides per person):
 *
 *   mode "comp" (default) — complimentary Faculty companion (badge / entry
 *   barcode / check-in / survey). Idempotent via
 *   ensureSpeakerCompanionRegistration:
 *     already linked                        → no-op (`already-linked`)
 *     same-email NON-CANCELLED registration → link it (`linked-by-email`)
 *     otherwise (incl. only-cancelled ones) → create a fresh comp Faculty
 *                                             companion (`created`)
 *
 *   mode "payable" — a REAL registration on a chosen ticket type (+ optional
 *   pricing tier), minted from the details the speaker already provided, via
 *   registration-service.createRegistration — which owns seat claim, payment
 *   defaulting (UNASSIGNED for paid) and the confirmation email + quote PDF
 *   with the Pay Now link, so the person is asked for payment automatically.
 *   The new registration is linked as the speaker's attendee facet. A
 *   same-email existing registration is linked instead of duplicated
 *   (`linked-existing`).
 *
 * History: the July 30, 2026 model auto-comped proposal signups with a
 * per-person REVOKE; reversed Aug 5, 2026 (most proposers are invited faculty,
 * some must pay, some get comped — grant is now the explicit action).
 */

interface RouteParams {
  params: Promise<{ eventId: string; speakerId: string }>;
}

const grantBodySchema = z.object({
  mode: z.enum(["comp", "payable"]).default("comp"),
  ticketTypeId: z.string().optional(),
  pricingTierId: z.string().optional(),
});

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, speakerId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Lenient body parse — the historical comp grant POSTs an empty body.
    const rawBody = await req.json().catch(() => ({}));
    const parsedBody = grantBodySchema.safeParse(rawBody ?? {});
    if (!parsedBody.success) {
      apiLogger.warn({
        msg: "grant-companion:invalid-body",
        eventId,
        speakerId,
        errors: parsedBody.error.flatten().fieldErrors,
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsedBody.error.flatten() },
        { status: 400 },
      );
    }
    const body = parsedBody.data;

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

    // ── Payable mode ─────────────────────────────────────────────────────
    if (body.mode === "payable") {
      if (!body.ticketTypeId) {
        apiLogger.warn({ msg: "grant-companion:ticket-type-required", eventId, speakerId });
        return NextResponse.json(
          { error: "Pick a registration type for a payable registration", code: "TICKET_TYPE_REQUIRED" },
          { status: 400 },
        );
      }
      // A live linked registration means they already have their facet —
      // granting a second (payable) one would double-register them.
      if (speaker.sourceRegistrationId && speaker.sourceRegistration?.status !== "CANCELLED") {
        apiLogger.warn({ msg: "grant-companion:already-has-registration", eventId, speakerId });
        return NextResponse.json(
          {
            error: "This speaker already has a linked registration",
            code: "ALREADY_HAS_REGISTRATION",
            registrationId: speaker.sourceRegistrationId,
          },
          { status: 409 },
        );
      }

      const created = await createRegistration({
        eventId,
        organizationId: session.user.organizationId ?? "",
        userId: session.user.id,
        ticketTypeId: body.ticketTypeId,
        pricingTierId: body.pricingTierId ?? null,
        attendee: {
          // Speaker's Title/AttendeeRole enums are value-identical to the
          // service's narrowed string unions.
          title: (speaker.title as RegistrationTitle | null) ?? null,
          role: (speaker.role as RegistrationAttendeeRole | null) ?? null,
          email: speaker.email,
          additionalEmail: speaker.additionalEmail,
          firstName: speaker.firstName,
          lastName: speaker.lastName,
          organization: speaker.organization,
          jobTitle: speaker.jobTitle,
          phone: speaker.phone,
          photo: speaker.photo,
          city: speaker.city,
          state: speaker.state,
          zipCode: speaker.zipCode,
          country: speaker.country,
          specialty: speaker.specialty,
        },
        source: "rest",
        requestIp: getClientIp(req),
        actorFirstName: session.user.firstName ?? null,
      });

      if (!created.ok) {
        // Same-email registration already exists → link it as the facet
        // instead of failing (the service's dup check excludes CANCELLED,
        // so the row is live).
        const existingId =
          created.code === "ALREADY_REGISTERED"
            ? (created.meta?.existingRegistrationId as string | undefined)
            : undefined;
        if (existingId) {
          await db.speaker.update({
            where: { id: speaker.id },
            data: { sourceRegistrationId: existingId },
          });
          apiLogger.info({
            msg: "grant-companion:linked-existing-payable",
            eventId,
            speakerId,
            registrationId: existingId,
          });
          return NextResponse.json({ ok: true, outcome: "linked-existing", registrationId: existingId });
        }
        apiLogger.warn({
          msg: "grant-companion:payable-rejected",
          eventId,
          speakerId,
          code: created.code,
          detail: created.message,
        });
        return NextResponse.json(
          { error: created.message, code: created.code },
          { status: created.code === "UNKNOWN" ? 500 : 400 },
        );
      }

      await db.speaker.update({
        where: { id: speaker.id },
        data: { sourceRegistrationId: created.registration.id },
      });
      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "COMPANION_GRANTED",
            entityType: "Speaker",
            entityId: speaker.id,
            changes: {
              mode: "payable",
              registrationId: created.registration.id,
              ticketTypeId: body.ticketTypeId,
              pricingTierId: body.pricingTierId ?? null,
              paymentStatus: created.registration.paymentStatus,
              outcome: "payable-created",
            },
            ipAddress: getClientIp(req),
          },
        })
        .catch((err) =>
          apiLogger.warn({ err, msg: "grant-companion:audit-failed", speakerId }),
        );
      apiLogger.info({
        msg: "grant-companion:payable-created",
        eventId,
        speakerId,
        registrationId: created.registration.id,
        paymentStatus: created.registration.paymentStatus,
        userId: session.user.id,
      });
      return NextResponse.json({
        ok: true,
        outcome: "payable-created",
        registrationId: created.registration.id,
        paymentStatus: created.registration.paymentStatus,
      });
    }

    // ── Comp mode (default) ──────────────────────────────────────────────
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
