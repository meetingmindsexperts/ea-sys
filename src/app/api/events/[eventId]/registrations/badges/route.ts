import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, REGISTRATION_DESK_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { isPaymentAdmissible } from "@/lib/check-in";
import { readBadgeLayout } from "@/lib/badge-layout";
import { generateBadgePDF } from "@/lib/badge-pdf";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

// H4: a "Print All" larger than this is refused (batch instead) so one request
// can't build a multi-thousand-page PDF on the box that serves the live
// scanner. Well above a realistic single event (MM Group runs 500-2000).
const MAX_BADGES_PER_REQUEST = 2500;

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ONSITE (registration-desk staff) is allowed to print badges.
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW, route: "events/[eventId]/registrations/badges:POST" });
    if (denied) return denied;

    return await runWithTenantLane(session.user.organizationId, { route: "registrations:badges", userId: session.user.id }, async () => {
    const event = await db.event.findFirst({
      // Assignment-scoped for ONSITE (per-event desk staff) — an ONSITE user may
      // only print badges for events they're assigned to (badge PDFs carry entry
      // barcodes). Org-scoped (unchanged) for admin/organizer.
      where: buildEventAccessWhere(session.user, eventId, { surface: "desk" }),
      select: { id: true, badgeVerticalOffset: true, settings: true, requiresDtcmBarcode: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json();
    const { registrationIds, all } = body as {
      registrationIds?: string[];
      all?: boolean;
    };

    // Virtual attendees have no venue presence (and no qrCode) — never badge
    // them, even if explicitly selected.
    const where = all
      ? { eventId, status: { not: "CANCELLED" as const }, attendanceMode: { not: "VIRTUAL" as const } }
      : { eventId, id: { in: registrationIds || [] }, attendanceMode: { not: "VIRTUAL" as const } };

    // H4: guard against an unbounded "Print All" building a multi-thousand-page
    // PDF in one request on the box that also serves the live scanner. `take`
    // one past the cap so we can tell "at the cap" from "over it". Realistic
    // events (≤ a couple thousand) pass; a runaway falls back to batching.
    const allRegistrations = await db.registration.findMany({
      where,
      take: MAX_BADGES_PER_REQUEST + 1,
      select: {
        id: true,
        serialId: true,
        qrCode: true,
        dtcmBarcode: true,
        badgeType: true,
        paymentStatus: true,
        // Needed by isPaymentAdmissible: a REFUNDED registration is badge-able
        // only while its status says the place still stands.
        status: true,
        attendee: { select: { firstName: true, lastName: true, country: true, organization: true } },
        ticketType: { select: { name: true, price: true } },
        pricingTier: { select: { price: true } },
      },
      orderBy: [{ attendee: { lastName: "asc" } }, { attendee: { firstName: "asc" } }],
    });

    // Badge everyone the door would admit — the SAME predicate as the check-in
    // gate (review H1). This route used to filter `PAID || complimentary`,
    // silently dropping sponsor-paid (INCLUSIVE) and pay-at-desk (UNASSIGNED)
    // delegates who scan in fine but then have no badge. `isPaymentAdmissible`
    // is the shared source of truth so the two can't drift again.
    const registrations = allRegistrations.filter((r) =>
      isPaymentAdmissible({
        paymentStatus: r.paymentStatus,
        status: r.status,
        ticketTypePrice: r.ticketType?.price ?? null,
        pricingTierPrice: r.pricingTier?.price ?? null,
      }),
    );

    if (registrations.length === 0) {
      // Distinguish "you selected people who owe money" from "your selection
      // matched nobody at all". The first is the common case and it has a
      // REMEDY, which the old message did not name.
      //
      // It is also the dead end behind the desk's payment override: the
      // override sets status + checkedInAt and deliberately never touches
      // `paymentStatus`, so an admitted attendee is still filtered out here.
      // The operator got a bare refusal with no next step. Recording the
      // payment is the action that clears both, so the message says so.
      const droppedForPayment = allRegistrations.length;
      apiLogger.warn(
        {
          msg: "badges:no-eligible-registrations",
          eventId,
          requested: all ? "all" : (registrationIds?.length ?? 0),
          matched: droppedForPayment,
          droppedForPayment,
        },
        "No badge-eligible registrations",
      );

      if (droppedForPayment === 0) {
        return NextResponse.json(
          {
            error: "No registrations matched. Check the selection and try again.",
            code: "BADGE_NO_MATCH",
          },
          { status: 400 },
        );
      }

      return NextResponse.json(
        {
          error:
            droppedForPayment === 1
              ? "This registration still owes payment, so its badge can't be printed. Record the payment under Billing & Payments, or set the payment status to Complimentary, then print."
              : `None of the ${droppedForPayment} selected registrations can be badged — they all still owe payment (unpaid or pending). Record their payment, or set them to Complimentary, then print.`,
          code: "BADGE_PAYMENT_REQUIRED",
          blocked: droppedForPayment,
        },
        { status: 400 },
      );
    }

    // H4: over the per-request cap. Refuse rather than freeze the box mid-render.
    if (registrations.length > MAX_BADGES_PER_REQUEST) {
      apiLogger.warn(
        { msg: "badges:over-cap", eventId, cap: MAX_BADGES_PER_REQUEST, matched: registrations.length },
        "Badge request exceeds the per-request cap",
      );
      return NextResponse.json(
        {
          error: `Too many badges for one request (limit ${MAX_BADGES_PER_REQUEST}). Filter by registration type or select a batch, then print again.`,
          code: "BADGE_LIMIT_EXCEEDED",
          limit: MAX_BADGES_PER_REQUEST,
        },
        { status: 400 }
      );
    }

    // Organiser-controlled size + placement on the A4 sheet. `readBadgeLayout`
    // is the ONE reader: it clamps every field and folds in the legacy
    // `badgeVerticalOffset` column, so an event that has never opened the new
    // form keeps its existing calibration and prints an identical badge.
    const layout = readBadgeLayout(event);
    // DTCM QRs render only on flagged (Dubai) events — a stale dtcmBarcode
    // value on an unflagged event must not change its badge output.
    const includeDtcm = !!event.requiresDtcmBarcode;
    const dtcmCount = includeDtcm ? registrations.filter((r) => !!r.dtcmBarcode).length : 0;
    const pdfBuffer = await generateBadgePDF(registrations, layout, includeDtcm);
    if (includeDtcm) {
      apiLogger.info({
        msg: "badges:dtcm-rendered",
        eventId,
        badges: registrations.length,
        withDtcmQr: dtcmCount,
        missingDtcm: registrations.length - dtcmCount,
      }, "DTCM-flagged event — QR codes rendered on badges carrying a DTCM barcode");
    }

    // Record the print for analytics ("badges printed vs registered" +
    // reprints). Awaited but failure-isolated — a tracking error must never
    // block handing the operator their PDF. badgePrintedAt is set only on the
    // first print (where still null); badgePrintCount bumps every time; the
    // AuditLog row gives the per-print timeline + who/when.
    const printedIds = registrations.map((r) => r.id);
    try {
      // Interactive form (was array-form): array form can't carry the tenant
      // SET LOCAL, so the same three writes run sequentially in one
      // tenantTransaction (flag-off identical). The id-list updateManys are
      // event-bound so a crafted id list can't touch another event's rows.
      await tenantTransaction(async (tx) => {
        await tx.registration.updateMany({
          where: { id: { in: printedIds }, eventId },
          data: { badgePrintCount: { increment: 1 } },
        });
        await tx.registration.updateMany({
          where: { id: { in: printedIds }, eventId, badgePrintedAt: null },
          data: { badgePrintedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            eventId,
            userId: session.user.id,
            action: "BADGE_PRINTED",
            entityType: "Registration",
            entityId: `bulk:${printedIds.length}`,
            // Cap the id list so a 1000-badge print doesn't bloat the row;
            // the count is the headline figure for analytics.
            changes: {
              count: printedIds.length,
              all: !!all,
              // DTCM audit trail (Badge=Faculty-style): how many printed badges
              // carried the Dubai compliance QR vs were still missing a code.
              dtcmQrCount: dtcmCount,
              registrationIds: printedIds.slice(0, 200),
            },
            ipAddress: getClientIp(req),
          },
        });
      });
    } catch (err) {
      apiLogger.error({ err, msg: "Failed to record badge-print analytics", eventId, count: printedIds.length });
    }

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="badges-${eventId}.pdf"`,
      },
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error generating badges" });
    return NextResponse.json({ error: "Badge generation failed" }, { status: 500 });
  }
}
