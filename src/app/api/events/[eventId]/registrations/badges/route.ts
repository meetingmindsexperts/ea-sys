import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { requirePermission } from "@/lib/permissions/require-permission";
import { getClientIp } from "@/lib/security";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { isPaymentAdmissible } from "@/lib/check-in";
import { printedBadgeType, readBadgeLayout } from "@/lib/badge-layout";
import { generateBadgePDF } from "@/lib/badge-pdf";
import { badgePrintHeaders, badgeRefusal } from "@/lib/badge-print-result";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

// H4: a "Print All" larger than this is refused (batch instead) so one request
// can't build a multi-thousand-page PDF on the box that serves the live
// scanner. Well above a realistic single event (MM Group runs 500-2000).
const MAX_BADGES_PER_REQUEST = 2500;

/**
 * Badge request body (Sep 21, 2026 security review, finding #7).
 *
 * `body as { registrationIds?: string[] }` is an assertion, not a parse: at
 * runtime the array could hold numbers or objects and went into
 * `id: { in: ... }` as-is, surfacing as a 500 rather than a 400. The
 * authorisation was never the problem — the `where` is bound to `eventId`, so
 * a hostile array could not reach another event's rows — only the shape was
 * untyped.
 *
 * The array cap is a SANITY bound, set well above MAX_BADGES_PER_REQUEST on
 * purpose. The route's own cap below is what refuses a realistic overflow,
 * and it does so with an actionable BADGE_LIMIT_EXCEEDED ("select a batch,
 * then print again"); a schema cap at the same number would intercept that
 * case first with a generic "Invalid input", which review flagged. This one
 * exists only to keep a 100k-id payload out of the Postgres `IN` clause.
 */
const badgeRequestSchema = z.object({
  registrationIds: z.array(z.string()).max(MAX_BADGES_PER_REQUEST * 4).optional(),
  all: z.boolean().optional(),
});

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ONSITE (registration-desk staff) is allowed to print badges.
    const gate = requirePermission(session, "registrations.badges.print", { route: "events/[eventId]/registrations/badges:POST", eventId });
    if (!gate.ok) return gate.response;

    return await runWithTenantLane(session.user.organizationId, { route: "registrations:badges", userId: session.user.id }, async () => {
    const event = await db.event.findFirst({
      // Assignment-scoped for ONSITE (per-event desk staff) — an ONSITE user may
      // only print badges for events they're assigned to (badge PDFs carry entry
      // barcodes). Org-scoped (unchanged) for admin/organizer.
      where: gate.eventWhere,
      select: { id: true, badgeVerticalOffset: true, settings: true, requiresDtcmBarcode: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const raw = await req.json().catch(() => null);
    if (raw === null) {
      apiLogger.warn({ msg: "badges:invalid-json", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Invalid JSON body", code: "INVALID_JSON" }, { status: 400 });
    }
    const parsed = badgeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route: "badges:POST", eventId, userId: session.user.id });
    }
    const { registrationIds, all } = parsed.data;

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
        // The authoritative "what they owe". Without it a tier-priced
        // registration on a 0-base ticket type reads as free.
        originalPrice: true,
        // A code that takes the whole price owes nothing, so they get a badge.
        discountAmount: true,
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
    const admissible = (r: (typeof allRegistrations)[number]) =>
      isPaymentAdmissible({
        paymentStatus: r.paymentStatus,
        status: r.status,
        originalPrice: r.originalPrice,
        discountAmount: r.discountAmount,
        ticketTypePrice: r.ticketType?.price ?? null,
        pricingTierPrice: r.pricingTier?.price ?? null,
      });
    // A cancelled registration gets no badge (owner, Nov 13, 2026). "Print all"
    // never asks for one; by id (Print Selected, the registration's own sheet)
    // the payment rule was the only test, and it does not look at CANCELLED
    // (the door checks that separately), so a cancelled registration that was
    // paid or complimentary printed and was stamped as printed. Kept in the
    // query and refused here, not filtered out of it, so the refusal can say
    // "cancelled" instead of "no registrations matched".
    const registrations = allRegistrations.filter((r) => r.status !== "CANCELLED" && admissible(r));
    // The rest of the selection: told to the operator with the PDF (below),
    // not dropped in silence. A bulk print of 50 used to come back as 47
    // badges and "Badges ready to print" (owner, Nov 13, 2026).
    //
    // "Payment due" is only someone who really owes (review of b19e5e44). The
    // door's rule also turns away a REFUNDED registration whose place no
    // longer stands, and a selection by id can hold CANCELLED rows (the list
    // shows them, and its select-all ticks them): neither is told to "record
    // the payment". They are counted with the virtual and the vanished below.
    const leftOutForPayment = allRegistrations.filter(
      (r) => !admissible(r) && r.status !== "CANCELLED" && r.paymentStatus !== "REFUNDED",
    );
    // Everyone else asked for and not printed, so the figures add up to the
    // selection. For "all" that is only what the query matched.
    const requested = all ? allRegistrations.length : new Set(registrationIds ?? []).size;
    const noBadge = Math.max(0, requested - registrations.length - leftOutForPayment.length);

    if (registrations.length === 0) {
      // Nothing to print. The refusal names the true reason and, for money
      // owed, its remedy (badge-print-result.ts). That one is also the dead
      // end behind the desk's payment override: the override sets status +
      // checkedInAt and deliberately never touches `paymentStatus`, so an
      // admitted attendee is still refused here until the payment is recorded.
      const refusal = badgeRefusal({
        matched: allRegistrations.length,
        paymentDue: leftOutForPayment.length,
        cancelled: allRegistrations.filter((r) => r.status === "CANCELLED").length,
      });
      apiLogger.warn({
        msg: "badges:no-eligible-registrations",
        eventId,
        userId: session.user.id,
        requested: all ? "all" : (registrationIds?.length ?? 0),
        matched: allRegistrations.length,
        droppedForPayment: leftOutForPayment.length,
        code: refusal.code,
        detail: "No badge-eligible registrations",
      });
      return NextResponse.json(refusal, { status: 400 });
    }

    // H4: over the per-request cap. Refuse rather than freeze the box mid-render.
    if (registrations.length > MAX_BADGES_PER_REQUEST) {
      apiLogger.warn(
        { msg: "badges:over-cap", eventId, cap: MAX_BADGES_PER_REQUEST, matched: registrations.length, detail: "Badge request exceeds the per-request cap" },
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
    if (leftOutForPayment.length > 0 || noBadge > 0) {
      // info, not warn: the print succeeded, and some owing before an event is
      // the ordinary state of a Print All (warn feeds the error-rate card).
      apiLogger.info({
        msg: "badges:left-out",
        eventId,
        userId: session.user.id,
        printed: registrations.length,
        paymentDue: leftOutForPayment.length,
        noBadge,
        detail: "Part of the selection was not printed: payment due, or no badge (virtual, cancelled, refunded, gone)",
      });
    }

    const layout = readBadgeLayout(event);
    // DTCM QRs render only on flagged (Dubai) events — a stale dtcmBarcode
    // value on an unflagged event must not change its badge output.
    const includeDtcm = !!event.requiresDtcmBarcode;
    const dtcmCount = includeDtcm ? registrations.filter((r) => !!r.dtcmBarcode).length : 0;
    // A blank badge type on the Exhibitor registration type prints EXHIBITOR
    // with the exhibitor field set (rows from before the type set it).
    const printable = registrations.map((r) => ({ ...r, badgeType: printedBadgeType(r.badgeType, r.ticketType?.name) }));
    const pdfBuffer = await generateBadgePDF(printable, layout, includeDtcm);
    if (includeDtcm) {
      apiLogger.info({
        msg: "badges:dtcm-rendered",
        eventId,
        badges: registrations.length,
        withDtcmQr: dtcmCount,
        missingDtcm: registrations.length - dtcmCount,
        detail: "DTCM-flagged event: QR codes rendered on badges carrying a DTCM barcode",
      });
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
            // Every id (a print is capped at MAX_BADGES_PER_REQUEST, so at most
            // about 65 KB): each person's activity timeline finds its prints
            // here (activity-feed.ts). Until Oct 24, 2026 only the first 200
            // were kept, so older large batches name only part of the run.
            changes: {
              count: printedIds.length,
              all: !!all,
              // DTCM audit trail (Badge=Faculty-style): how many printed badges
              // carried the Dubai compliance QR vs were still missing a code.
              dtcmQrCount: dtcmCount,
              // Asked for and not printed: payment due (told to the operator too).
              paymentDueLeftOut: leftOutForPayment.length,
              registrationIds: printedIds,
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
        // How many are in the PDF and who was left out for payment: the body
        // is the PDF, so the Badges dialog reads these (badge-print-result.ts).
        ...badgePrintHeaders(registrations.length, leftOutForPayment, noBadge),
      },
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error generating badges" });
    return NextResponse.json({ error: "Badge generation failed" }, { status: 500 });
  }
}
