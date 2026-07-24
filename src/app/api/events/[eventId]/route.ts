import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { canViewFinance, redactFinancialFields } from "@/lib/finance-visibility";
import { denyReviewer } from "@/lib/auth-guards";
import { updateEventSettings } from "@/lib/event-settings";
import {
  isSessionWithinEventDates,
  localDateInTz,
  resolveTimezone,
} from "@/lib/event-time";
import { getClientIp } from "@/lib/security";
import { notifyEventAdmins } from "@/lib/notifications";
import { surveyConfigSchema } from "@/lib/survey/schema";

const updateEventSchema = z.object({
  name: z.string().min(2).max(255).optional(),
  slug: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  eventType: z.enum(["CONFERENCE", "WEBINAR", "HYBRID"]).nullable().optional(),
  tag: z.string().max(255).nullable().optional(),
  specialty: z.string().max(255).nullable().optional(),
  code: z.string().max(20).nullable().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  timezone: z.string().max(100).optional(),
  venue: z.string().max(255).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  city: z.string().max(255).nullable().optional(),
  country: z.string().max(255).nullable().optional(),
  supportEmail: z.string().email().max(255).nullable().optional(),
  status: z.enum(["DRAFT", "PUBLISHED", "LIVE", "COMPLETED", "CANCELLED"]).optional(),
  bannerImage: z.string().max(500).nullable().optional(),
  bannerImageMobile: z.string().max(500).nullable().optional(),
  footerHtml: z.string().max(10000).nullable().optional(),
  emailHeaderImage: z.string().max(500).nullable().optional(),
  emailFooterImage: z.string().max(500).nullable().optional(),
  emailFooterHtml: z.string().max(10000).nullable().optional(),
  emailFromAddress: z.string().email().max(255).nullable().optional(),
  emailFromName: z.string().max(255).nullable().optional(),
  // Per-event auto-CC list. Server re-validates each entry against the
  // email regex and lowercases — the UI does the same on save, this is
  // belt-and-braces for direct API callers.
  emailCcAddresses: z
    .array(z.string().trim().toLowerCase().email().max(255))
    .max(20)
    .optional(),
  registrationTermsHtml: z.string().max(50000).nullable().optional(),
  registrationWelcomeHtml: z.string().max(50000).nullable().optional(),
  abstractWelcomeHtml: z.string().max(50000).nullable().optional(),
  abstractGuidelinesHtml: z.string().max(50000).nullable().optional(),
  abstractTermsHtml: z.string().max(50000).nullable().optional(),
  abstractConfirmationHtml: z.string().max(50000).nullable().optional(),
  registrationConfirmationHtml: z.string().max(50000).nullable().optional(),
  speakerAgreementHtml: z.string().max(50000).nullable().optional(),
  surveyIntroHtml: z.string().max(50000).nullable().optional(),
  taxRate: z.number().min(0).max(100).nullable().optional(),
  taxLabel: z.string().max(50).nullable().optional(),
  bankDetails: z.string().max(5000).nullable().optional(),
  badgeVerticalOffset: z.number().int().min(-200).max(200).optional(),
  // Event-wide attendee cap. 0 or null = unlimited (the Settings UI labels the
  // input "0 = unlimited"); stored as null. Setting a cap RECOMPUTES
  // Event.seatCount from row-truth in the same transaction (self-healing) and
  // is rejected when below the current attendee count.
  maxAttendees: z.number().int().min(0).max(1000000).nullable().optional(),
  // Dubai (DET/DTCM) compliance toggle — surfaces the per-registration
  // DTCM barcode field for this event only.
  requiresDtcmBarcode: z.boolean().optional(),
  // Per-event post-event feedback survey definition. Null clears the
  // survey (subsequent token mints + form loads will 404). See
  // src/lib/survey/schema.ts for the Zod-validated shape — duplicate
  // question ids and >50 questions are rejected by the inner schema.
  surveyConfig: surveyConfigSchema.nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    // Parallelize params and auth for faster response
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      include: {
        _count: {
          select: {
            registrations: true,
            speakers: true,
            eventSessions: true,
            tracks: true,
          },
        },
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // MEMBER sees event config (general, branding) but not the financial
    // fields — taxRate / taxLabel / bankDetails are stripped. UI renders
    // "—" for the masked fields on the Settings → Registration tab.
    const payload = canViewFinance(session.user.role)
      ? event
      : redactFinancialFields(event);

    // Add cache headers for better performance
    const response = NextResponse.json(payload);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching event" });
    return NextResponse.json(
      { error: "Failed to fetch event" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    // Parallelize params, auth, and body parsing
    const [{ eventId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session);
    if (denied) return denied;

    // Verify event belongs to user's organization (use select for minimal data)
    const existingEvent = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: {
        id: true,
        slug: true,
        status: true,
        settings: true,
        startDate: true,
        endDate: true,
        timezone: true,
      },
    });

    if (!existingEvent) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    const validated = updateEventSchema.safeParse(body);

    if (!validated.success) {
      const details = validated.error.flatten();
      apiLogger.warn({ msg: "Event update validation failed", eventId, userId: session.user.id, errors: details, body });
      return NextResponse.json(
        { error: "Invalid input", details },
        { status: 400 }
      );
    }

    const {
      name,
      slug,
      description,
      eventType,
      tag,
      specialty,
      code,
      startDate,
      endDate,
      timezone,
      venue,
      address,
      city,
      country,
      supportEmail,
      status,
      bannerImage,
      bannerImageMobile,
      footerHtml,
      emailHeaderImage,
      emailFooterImage,
      emailFooterHtml,
      emailFromAddress,
      emailFromName,
      emailCcAddresses,
      registrationTermsHtml,
      registrationWelcomeHtml,
      abstractWelcomeHtml,
      abstractGuidelinesHtml,
      abstractTermsHtml,
      abstractConfirmationHtml,
      registrationConfirmationHtml,
      speakerAgreementHtml,
      surveyIntroHtml,
      taxRate,
      taxLabel,
      bankDetails,
      badgeVerticalOffset,
      requiresDtcmBarcode,
      maxAttendees,
      surveyConfig,
      settings,
    } = validated.data;

    // If slug is being changed, check for uniqueness
    if (slug && slug !== existingEvent.slug) {
      const slugExists = await db.event.findFirst({
        where: {
          organizationId: orgGuard.orgId,
          slug,
          id: { not: eventId },
        },
      });

      if (slugExists) {
        return NextResponse.json(
          { error: "An event with this slug already exists" },
          { status: 400 }
        );
      }
    }

    // M9 (program/agenda review): narrowing the event's dates (or moving its
    // timezone) used to silently orphan out-of-range sessions — they kept
    // rendering on the public agenda while any edit to them was rejected by
    // isSessionWithinEventDates. Block the save with a clear error naming the
    // sessions instead; the organizer moves or deletes them first.
    //
    // Gate on a COMPUTED change, not field presence — the Settings → General
    // form always sends startDate/endDate/timezone, so a presence gate made
    // every General save re-run the guard and locked ALL General edits on an
    // event that already had a legacy out-of-range session (review H1).
    const effectiveStart = startDate ? new Date(startDate) : existingEvent.startDate;
    const effectiveEnd = endDate ? new Date(endDate) : existingEvent.endDate;
    const effectiveTz = resolveTimezone(timezone ?? existingEvent.timezone);
    const datesOrTzChanged =
      (startDate || endDate || timezone) &&
      (effectiveStart.getTime() !== existingEvent.startDate?.getTime() ||
        effectiveEnd.getTime() !== existingEvent.endDate?.getTime() ||
        effectiveTz !== resolveTimezone(existingEvent.timezone));
    if (datesOrTzChanged) {
      // CANCELLED sessions are excluded — they no longer render on the agenda
      // and must not block a legitimate date change.
      const eventSessions = await db.eventSession.findMany({
        where: { eventId, status: { not: "CANCELLED" } },
        select: { id: true, name: true, startTime: true, endTime: true },
      });
      const outOfRange = eventSessions.filter(
        (s) =>
          !isSessionWithinEventDates(
            s.startTime,
            s.endTime,
            effectiveStart,
            effectiveEnd,
            effectiveTz,
          ),
      );
      if (outOfRange.length > 0) {
        const listed = outOfRange
          .slice(0, 5)
          .map((s) => `"${s.name}" (${localDateInTz(s.startTime, effectiveTz)})`)
          .join(", ");
        const more = outOfRange.length > 5 ? ` and ${outOfRange.length - 5} more` : "";
        apiLogger.warn({
          msg: "event-update:sessions-outside-new-dates",
          eventId,
          userId: session.user.id,
          outOfRangeCount: outOfRange.length,
          sessionIds: outOfRange.map((s) => s.id),
        });
        return NextResponse.json(
          {
            error: `Cannot change the event dates: ${outOfRange.length} session(s) would fall outside the new date range — ${listed}${more}. Move or delete them first (Agenda page).`,
            code: "SESSIONS_OUTSIDE_NEW_DATES",
            sessions: outOfRange.map((s) => ({
              id: s.id,
              name: s.name,
              startTime: s.startTime,
              endTime: s.endTime,
            })),
          },
          { status: 400 },
        );
      }
    }

    // Event-wide attendee cap (maxAttendees): recompute-on-set. The counter
    // (Event.seatCount) starts at 0 and can drift while no cap is active, so
    // the moment a cap is set/changed we recompute it from row-truth INSIDE the
    // same transaction, under a row lock on the Event so concurrent
    // registration claims serialize against the recount. Reject a cap below
    // the current count (same rule as the type/tier quantity guards) — to stop
    // sales, use the Registration Open toggle instead.
    if (maxAttendees !== undefined) {
      const effectiveMax = maxAttendees === 0 ? null : maxAttendees;
      const capResult = await db.$transaction(async (tx) => {
        // Row lock: claimEventSeats/releaseEventSeats UPDATEs block until this
        // tx commits, so the recount can't be raced by a concurrent claim.
        await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
        // Row-truth mirror of holdsEventSeat()/seatCounter(): non-cancelled,
        // in-person, not a speaker companion, on a ticket type. The explicit
        // OR keeps null createdSource rows IN (Prisma `not` excludes nulls).
        const currentCount = await tx.registration.count({
          where: {
            eventId,
            status: { not: "CANCELLED" },
            attendanceMode: "IN_PERSON",
            ticketTypeId: { not: null },
            OR: [
              { createdSource: null },
              { createdSource: { not: "SPEAKER_COMPANION" } },
            ],
          },
        });
        if (effectiveMax != null && effectiveMax < currentCount) {
          return { ok: false as const, currentCount };
        }
        await tx.event.update({
          where: { id: eventId },
          data: { maxAttendees: effectiveMax, seatCount: currentCount },
        });
        return { ok: true as const, currentCount };
      });
      if (!capResult.ok) {
        apiLogger.warn({
          msg: "event-update:max-attendees-below-count",
          eventId,
          requestedMax: effectiveMax,
          currentCount: capResult.currentCount,
          userId: session.user.id,
        });
        return NextResponse.json(
          {
            error: `Maximum attendees cannot be less than the current attendee count (${capResult.currentCount}). To stop new registrations, switch Registration Open off instead.`,
            code: "EVENT_CAP_BELOW_COUNT",
            currentCount: capResult.currentCount,
          },
          { status: 400 },
        );
      }
      apiLogger.info({
        msg: "event-update:max-attendees-set",
        eventId,
        maxAttendees: effectiveMax,
        recomputedSeatCount: capResult.currentCount,
        userId: session.user.id,
      });
    }

    // Merge settings if provided — protect managed keys from being overwritten.
    // The settings merge runs through the atomic read-merge-write helper so a
    // concurrent settings writer (reviewers API, sponsors, webinar, …) can't be
    // clobbered. Strip reviewerUserIds first so the general PUT can't overwrite
    // the reviewer list — the helper preserves the existing value automatically.
    if (settings) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { reviewerUserIds: _protected, ...safeSettings } = settings;
      const cleanSettings = JSON.parse(JSON.stringify(safeSettings));
      await updateEventSettings(eventId, cleanSettings);
    }

    const event = await db.event.update({
      where: { id: eventId },
      data: {
        ...(name && { name }),
        ...(slug && { slug }),
        ...(description !== undefined && { description }),
        ...(eventType !== undefined && { eventType }),
        ...(tag !== undefined && { tag }),
        ...(specialty !== undefined && { specialty }),
        ...(code !== undefined && { code }),
        ...(startDate && { startDate: new Date(startDate) }),
        ...(endDate && { endDate: new Date(endDate) }),
        ...(timezone && { timezone }),
        ...(venue !== undefined && { venue }),
        ...(address !== undefined && { address }),
        ...(city !== undefined && { city }),
        ...(country !== undefined && { country }),
        ...(supportEmail !== undefined && { supportEmail }),
        ...(status && { status }),
        ...(bannerImage !== undefined && { bannerImage }),
        ...(bannerImageMobile !== undefined && { bannerImageMobile }),
        ...(footerHtml !== undefined && { footerHtml }),
        ...(emailHeaderImage !== undefined && { emailHeaderImage }),
        ...(emailFooterImage !== undefined && { emailFooterImage }),
        ...(emailFooterHtml !== undefined && { emailFooterHtml }),
        ...(emailFromAddress !== undefined && { emailFromAddress }),
        ...(emailFromName !== undefined && { emailFromName }),
        ...(emailCcAddresses !== undefined && { emailCcAddresses }),
        ...(registrationTermsHtml !== undefined && { registrationTermsHtml }),
        ...(registrationWelcomeHtml !== undefined && { registrationWelcomeHtml }),
        ...(abstractWelcomeHtml !== undefined && { abstractWelcomeHtml }),
        ...(abstractGuidelinesHtml !== undefined && { abstractGuidelinesHtml }),
        ...(abstractTermsHtml !== undefined && { abstractTermsHtml }),
        ...(abstractConfirmationHtml !== undefined && { abstractConfirmationHtml }),
        ...(registrationConfirmationHtml !== undefined && { registrationConfirmationHtml }),
        ...(speakerAgreementHtml !== undefined && { speakerAgreementHtml }),
        ...(surveyIntroHtml !== undefined && { surveyIntroHtml }),
        ...(taxRate !== undefined && { taxRate }),
        ...(taxLabel !== undefined && { taxLabel }),
        ...(bankDetails !== undefined && { bankDetails }),
        ...(badgeVerticalOffset !== undefined && { badgeVerticalOffset }),
        ...(requiresDtcmBarcode !== undefined && { requiresDtcmBarcode }),
        // surveyConfig: explicit null clears (set to JSON null in DB
        // via Prisma.JsonNull); array writes verbatim. The Zod schema
        // above guarantees the array shape is valid before reaching
        // here, so we cast through unknown to satisfy Prisma's
        // InputJsonValue (which doesn't model nested literal unions).
        ...(surveyConfig !== undefined && {
          surveyConfig:
            surveyConfig === null
              ? Prisma.JsonNull
              : (surveyConfig as unknown as Prisma.InputJsonValue),
        }),
      },
    });

    apiLogger.info({ msg: "Event updated", eventId, userId: session.user.id, fields: Object.keys(validated.data) });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "Event",
        entityId: eventId,
        changes: { ...JSON.parse(JSON.stringify(validated.data)), ip: getClientIp(req) },
      },
    });

    // Notify admins on status change
    if (validated.data.status && validated.data.status !== existingEvent.status) {
      notifyEventAdmins(eventId, {
        type: "REGISTRATION",
        title: "Event Status Updated",
        message: `Event "${event.name}" is now ${validated.data.status}`,
        link: `/events/${eventId}`,
      }).catch((err) => apiLogger.error({ err, msg: "Failed to send event status notification" }));
    }

    return NextResponse.json(event);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating event" });
    return NextResponse.json(
      { error: "Failed to update event" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    // Parallelize params and auth
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const deniedDel = denyReviewer(session);
    if (deniedDel) return deniedDel;

    // Require explicit confirmation to prevent accidental deletion
    const { searchParams } = new URL(req.url);
    if (searchParams.get("confirm") !== "true") {
      return NextResponse.json(
        { error: "Deleting an event removes all registrations, speakers, sessions, abstracts, and accommodations. Pass ?confirm=true to proceed." },
        { status: 400 }
      );
    }

    // Verify event belongs to user's organization (select only needed fields)
    const existingEvent = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, name: true },
    });

    if (!existingEvent) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // ── Data-loss guard: block event delete when financial records exist ──
    // Every Invoice (eventId) + Payment (via its registration) cascade-deletes
    // with the event. Block + write a DELETE_BLOCKED audit snapshot (bounded —
    // an event can hold many invoices) so nothing financial is destroyed by a
    // single event delete. Export first, then remove if truly needed.
    const [invoiceCount, paymentCount] = await Promise.all([
      db.invoice.count({ where: { eventId } }),
      db.payment.count({ where: { registration: { eventId } } }),
    ]);
    if (invoiceCount > 0 || paymentCount > 0) {
      const invoiceNumbers = (
        await db.invoice.findMany({
          where: { eventId },
          select: { invoiceNumber: true },
          orderBy: { createdAt: "desc" },
          take: 200,
        })
      ).map((i) => i.invoiceNumber);
      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "DELETE_BLOCKED",
            entityType: "Event",
            entityId: eventId,
            changes: {
              reason: "has-financial-records",
              invoiceCount,
              paymentCount,
              invoiceNumbers, // capped at 200
              ip: getClientIp(req),
            },
          },
        })
        .catch((err) => apiLogger.error({ err, msg: "Failed to create DELETE_BLOCKED audit log" }));
      apiLogger.warn({ msg: "event:delete-blocked-financial-records", eventId, invoiceCount, paymentCount });
      return NextResponse.json(
        {
          error:
            `This event has ${invoiceCount} invoice(s) and ${paymentCount} payment(s). ` +
            "Deleting it would permanently remove those financial records. " +
            "Export them first (Invoices → Export CSV / Download PDFs), then remove the event only if it must truly be deleted.",
          code: "EVENT_HAS_FINANCIAL_RECORDS",
          invoiceCount,
          paymentCount,
        },
        { status: 409 },
      );
    }

    await db.event.delete({
      where: { id: eventId },
    });

    apiLogger.info({ msg: "Event deleted", eventId, name: existingEvent.name, userId: session.user.id });

    // Log the action (non-blocking for better response time)
    db.auditLog.create({
      data: {
        userId: session.user.id,
        action: "DELETE",
        entityType: "Event",
        entityId: eventId,
        changes: { name: existingEvent.name, ip: getClientIp(req) },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting event" });
    return NextResponse.json(
      { error: "Failed to delete event" },
      { status: 500 }
    );
  }
}
