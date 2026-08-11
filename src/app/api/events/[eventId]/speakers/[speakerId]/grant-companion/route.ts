import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenantLane } from "@/lib/tenant-lane";
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
import { cancelRegistration } from "@/services/payment-service";

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

    // Body parse (review M2): only a genuinely EMPTY body means the historical
    // comp grant. A NON-empty body that fails to parse must 400 — silently
    // defaulting it to comp would mint a free registration when the caller
    // intended a payable one (silent wrong-action).
    const rawText = await req.text().catch(() => "");
    let rawBody: unknown = {};
    if (rawText.trim().length > 0) {
      try {
        rawBody = JSON.parse(rawText);
      } catch {
        apiLogger.warn({ msg: "grant-companion:unparseable-body", eventId, speakerId });
        return NextResponse.json(
          { error: "Request body is not valid JSON", code: "INVALID_JSON" },
          { status: 400 },
        );
      }
    }
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
    const orgId = session.user.organizationId;
    return await runWithTenantLane(orgId, { route: "speakers:grant-companion", userId: session.user.id }, async () => {
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
      // Review M6: the dialog requires a tier when the type has tiers — enforce
      // it server-side too. Without this, an API call on a tier-priced type
      // (base price 0) resolves to $0 → COMPLIMENTARY → NO payment email,
      // despite the caller asking for "payable".
      if (!body.pricingTierId) {
        const tierCount = await db.pricingTier.count({
          where: { ticketTypeId: body.ticketTypeId, ticketType: { eventId } },
        });
        if (tierCount > 0) {
          apiLogger.warn({
            msg: "grant-companion:tier-required",
            eventId,
            speakerId,
            ticketTypeId: body.ticketTypeId,
          });
          return NextResponse.json(
            {
              error: "This registration type is priced by pricing tier — pick one",
              code: "PRICING_TIER_REQUIRED",
            },
            { status: 400 },
          );
        }
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
        // Owner decision Aug 5, 2026 (review M5): a grant is an explicit
        // ORGANIZER action — proposal review happens after public sales
        // close, so the type's sales window must not block it. Capacity
        // (sold-out / event cap) still applies; the bypass is logged by
        // the service.
        overrideSalesWindow: true,
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
          // Conditional on the pointer we read — a concurrent grant that got
          // there first simply wins (both outcomes are links; benign).
          const linkClaim = await db.speaker.updateMany({
            where: { id: speaker.id, sourceRegistrationId: speaker.sourceRegistrationId },
            data: { sourceRegistrationId: existingId },
          });
          const finalId = linkClaim.count > 0
            ? existingId
            : (await db.speaker.findUnique({
                where: { id: speaker.id },
                select: { sourceRegistrationId: true },
              }))?.sourceRegistrationId ?? existingId;
          // H1: return the linked row's REAL state — the sheet must never
          // fabricate COMPLIMENTARY for what may be a PAID delegate row.
          const linkedRow = await db.registration.findFirst({
            where: { id: finalId, eventId },
            select: { status: true, paymentStatus: true },
          });
          // Review M4: this is the same state change the comp path audits —
          // a payable attempt that resolved to a link must be accountable too
          // (the organizer's chosen type/tier was NOT applied and NO payment
          // email was sent; the dialog toasts that honestly).
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
                  outcome: "linked-existing",
                  registrationId: finalId,
                  requestedTicketTypeId: body.ticketTypeId,
                  requestedPricingTierId: body.pricingTierId ?? null,
                },
                ipAddress: getClientIp(req),
              },
            })
            .catch((err) =>
              apiLogger.warn({ err, msg: "grant-companion:audit-failed", speakerId }),
            );
          apiLogger.info({
            msg: "grant-companion:linked-existing-payable",
            eventId,
            speakerId,
            registrationId: finalId,
          });
          return NextResponse.json({
            ok: true,
            outcome: "linked-existing",
            registrationId: finalId,
            status: linkedRow?.status ?? null,
            paymentStatus: linkedRow?.paymentStatus ?? null,
          });
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

      // CONDITIONAL claim on the pointer we validated (review H2): if a
      // concurrent grant linked something else meanwhile, we just minted a
      // DUPLICATE registration (whose confirmation email may already be out)
      // — compensate by cancelling it so nobody holds two live registrations.
      // A CRASH between the create above and this claim is self-healing: the
      // registration exists + is visible in the list, and a re-grant hits the
      // service's ALREADY_REGISTERED → links it (no duplicate email).
      const claim = await db.speaker.updateMany({
        where: { id: speaker.id, sourceRegistrationId: speaker.sourceRegistrationId },
        data: { sourceRegistrationId: created.registration.id },
      });
      if (claim.count === 0) {
        apiLogger.error({
          msg: "grant-companion:payable-race-lost",
          eventId,
          speakerId,
          duplicateRegistrationId: created.registration.id,
          userId: session.user.id,
        });
        const compensated = await cancelRegistration({
          registrationId: created.registration.id,
          eventId,
          organizationId: session.user.organizationId ?? "",
          refund: false,
          source: "rest",
          issuedByUserId: session.user.id,
        });
        if (!compensated.ok) {
          apiLogger.error({
            msg: "grant-companion:race-compensation-failed",
            eventId,
            speakerId,
            registrationId: created.registration.id,
            code: compensated.code,
          });
        }
        return NextResponse.json(
          {
            error:
              "Another grant for this speaker happened at the same time — the duplicate registration was cancelled. Check the speaker's linked registration; a payment-request email may have gone out for the cancelled duplicate.",
            code: "GRANT_RACE_LOST",
          },
          { status: 409 },
        );
      }
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
        // H1: real state — a requiresApproval type creates PENDING, not
        // CONFIRMED; the sheet renders what actually happened.
        status: created.registration.status,
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
    const result = await ensureSpeakerCompanionRegistration(
      {
        ...speakerInput,
        sourceRegistrationId:
          sourceRegistration?.status === "CANCELLED" ? null : speaker.sourceRegistrationId,
      },
      // H2: the helper's create step claims the link CONDITIONALLY on the RAW
      // pointer we read (the cancelled id on a re-grant, else null) — two
      // concurrent grants can't both mint a companion.
      { expectedLink: speaker.sourceRegistrationId },
    );

    // H1: return the row's REAL status/paymentStatus on every outcome — a
    // linked-by-email row can be a PAID delegate registration, and the sheet
    // must never fabricate COMPLIMENTARY (that exposed a no-refund Revoke).
    const linkedRow = await db.registration.findFirst({
      where: { id: result.registrationId ?? "", eventId },
      select: { status: true, paymentStatus: true },
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
      status: linkedRow?.status ?? null,
      paymentStatus: linkedRow?.paymentStatus ?? null,
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "grant-companion:failed" });
    return NextResponse.json({ error: "Failed to grant registration" }, { status: 500 });
  }
}
