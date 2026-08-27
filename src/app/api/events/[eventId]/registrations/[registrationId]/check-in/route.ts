import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, REGISTRATION_DESK_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { checkInGate, executeCheckIn, undoCheckIn } from "@/lib/check-in";
import { scannedEntryCodeCandidates } from "@/lib/barcode";
import { runWithTenantLane } from "@/lib/tenant-lane";

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

// The business gates (cancelled / payment-required / already-checked-in) and
// the commit + audit + notify fan-out live in src/lib/check-in.ts — shared
// with the QR handler below AND the MCP check_in_registration tool, so the
// three check-in surfaces can't drift (review H9: the MCP copy used to skip
// the payment gate and the audit row entirely).

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { eventId, registrationId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ONSITE (registration-desk staff) is allowed to check attendees in.
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW, route: "events/[eventId]/registrations/[registrationId]/check-in:POST" });
    if (denied) return denied;

    return await runWithTenantLane(session.user.organizationId, { route: "registrations:check-in", userId: session.user.id }, async () => {
    const event = await db.event.findFirst({
      // Assignment-scoped for ONSITE (per-event desk staff) — an ONSITE user may
      // only check in attendees for events they're assigned to. Org-scoped
      // (unchanged) for admin/organizer.
      where: buildEventAccessWhere(session.user, eventId, { surface: "desk" }),
      select: { id: true },
    });

    if (!event) {
      // H5: an ONSITE user hitting an event they're not assigned to lands here
      // (buildEventAccessWhere returned nothing) — log the cross-event denial.
      apiLogger.warn({ msg: "check-in:event-not-found", eventId, registrationId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        eventId,
      },
      include: {
        attendee: true,
        ticketType: true,
        pricingTier: { select: { price: true } },
      },
    });

    if (!registration) {
      apiLogger.warn({ msg: "check-in:registration-not-found", eventId, registrationId, userId: session.user.id });
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    // Optional body: `{ overridePayment: true }` is the audited desk override
    // for a payment-blocked attendee (review M1 — e.g. a webhook-lagged PENDING
    // whose Stripe payment actually succeeded). Owner decision July 11, 2026:
    // the override applies to ANY payment block (PENDING/UNPAID/FAILED…), and
    // is available to the same desk-gated population that can check people in.
    // The body is absent on the sheet's normal one-click check-in.
    const body = await req.json().catch(() => ({}));
    const overridePayment = body?.overridePayment === true;

    const gate = checkInGate(
      {
        status: registration.status,
        paymentStatus: registration.paymentStatus,
        checkedInAt: registration.checkedInAt,
        ticketTypePrice: registration.ticketType?.price,
        pricingTierPrice: registration.pricingTier?.price,
      },
      { allowPaymentDue: overridePayment },
    );
    if (gate) {
      apiLogger.warn({ msg: "check-in:rejected", eventId, registrationId, code: gate.code });
      return NextResponse.json(
        {
          error: gate.code === "CANCELLED" ? "Cannot check in a cancelled registration" : gate.message,
          // Machine-readable code so the sheet can offer the audited
          // "Admit anyway" override on PAYMENT_REQUIRED.
          code: gate.code,
          ...(gate.checkedInAt && { checkedInAt: gate.checkedInAt }),
        },
        { status: 400 }
      );
    }

    if (overridePayment) {
      // The override is a deliberate operator action — always leave a trace.
      apiLogger.warn({
        msg: "check-in:payment-override",
        eventId,
        registrationId,
        userId: session.user.id,
        paymentStatus: registration.paymentStatus,
      }, "Desk admitted a payment-blocked attendee via explicit override");
    }

    const updatedRegistration = await executeCheckIn({
      eventId,
      registrationId,
      actorUserId: session.user.id,
      attendeeName: `${registration.attendee.firstName} ${registration.attendee.lastName}`,
      source: "rest",
      auditExtras: {
        ip: getClientIp(req),
        ...(overridePayment && {
          paymentOverride: true,
          paymentStatusAtOverride: registration.paymentStatus,
        }),
      },
    });

    return NextResponse.json(updatedRegistration);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error checking in registration" });
    return NextResponse.json(
      { error: "Failed to check in" },
      { status: 500 }
    );
  }
}

// Check-in by QR code
export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const { eventId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ONSITE (registration-desk staff) is allowed to check attendees in.
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW, route: "events/[eventId]/registrations/[registrationId]/check-in:PUT" });
    if (denied) return denied;

    return await runWithTenantLane(session.user.organizationId, { route: "registrations:check-in", userId: session.user.id }, async () => {
    const event = await db.event.findFirst({
      // Assignment-scoped for ONSITE (per-event desk staff) — an ONSITE user may
      // only check in attendees for events they're assigned to. Org-scoped
      // (unchanged) for admin/organizer.
      where: buildEventAccessWhere(session.user, eventId, { surface: "desk" }),
      select: { id: true },
    });

    if (!event) {
      apiLogger.warn({ msg: "check-in-qr:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json();
    const { qrCode } = body;
    // Self-service kiosk scans tag themselves so the audit trail distinguishes
    // an attendee-driven kiosk check-in from a staff scanner check-in.
    const isKiosk = body.kiosk === true;

    if (!qrCode) {
      apiLogger.warn({ msg: "check-in-qr:missing-code", eventId, userId: session.user.id });
      return NextResponse.json({ error: "QR code or barcode required" }, { status: 400 });
    }

    // Search by qrCode OR dtcmBarcode. Rendered entry barcodes encode
    // `{qrCode}-{serialId}` (so a raw scanner dump identifies the person);
    // the stored value is the bare code, so the suffixed scan also tries its
    // bare prefix. DTCM values (external, arbitrary) always match as-is.
    const qrCandidates = scannedEntryCodeCandidates(String(qrCode));
    // findMany, not findFirst: DTCM codes stopped being unique on Aug 27 2026
    // (two registrations may deliberately share one), so a DTCM scan can match
    // more than one person and `findFirst` would silently check in whichever row
    // Postgres happened to return — the other one staying un-checked-in with
    // nothing anywhere saying why. Entry barcodes are still unique per
    // registration, so a match on one of those is never ambiguous.
    const matches = await db.registration.findMany({
      where: {
        eventId,
        OR: [
          { qrCode: { in: qrCandidates } },
          { dtcmBarcode: qrCode },
        ],
      },
      include: {
        attendee: true,
        ticketType: { select: { name: true, price: true } },
        pricingTier: { select: { price: true } },
      },
    });

    // Prefer the entry-barcode match. It identifies exactly one person by
    // construction, so a badge scan keeps working unchanged even when that
    // person's DTCM code is shared with someone else.
    const byEntry = matches.filter((r) => r.qrCode && qrCandidates.includes(r.qrCode));
    if (byEntry.length > 1) {
      // Cannot happen while qrCode is unique. Loud rather than arbitrary: if it
      // ever does, the door needs a human, not a coin flip.
      apiLogger.error({
        msg: "check-in:entry-barcode-ambiguous",
        eventId,
        matched: byEntry.length,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "This badge matches more than one registration. Please use the registration desk.", code: "AMBIGUOUS_SCAN" },
        { status: 409 },
      );
    }

    if (byEntry.length === 0 && matches.length > 1) {
      // A shared DTCM code. Refuse rather than guess — checking in the wrong one
      // of two people is worse than asking for the badge, and the badge carries
      // an entry barcode that resolves it immediately.
      apiLogger.warn({
        msg: "check-in:dtcm-code-shared",
        eventId,
        matched: matches.length,
        userId: session.user.id,
      });
      return NextResponse.json(
        {
          error: `This DTCM code is shared by ${matches.length} registrations, so it cannot identify one person. Scan the entry barcode on the badge instead.`,
          code: "AMBIGUOUS_SCAN",
        },
        { status: 409 },
      );
    }

    const registration = byEntry[0] ?? matches[0] ?? null;

    if (!registration) {
      // H5: the unknown-barcode scan is the single highest-value line to trace
      // at a live door ("why didn't that badge scan?") — a wrong-event badge, a
      // mis-print, or a probing/forged code. It logged nothing before.
      apiLogger.warn({ msg: "check-in:qr-unknown-code", eventId, userId: session.user.id, kiosk: isKiosk }, "Scanned code matched no registration");
      return NextResponse.json({ error: "Invalid code — not found" }, { status: 404 });
    }

    const gate = checkInGate({
      status: registration.status,
      paymentStatus: registration.paymentStatus,
      checkedInAt: registration.checkedInAt,
      ticketTypePrice: registration.ticketType?.price,
      pricingTierPrice: registration.pricingTier?.price,
    });
    if (gate) {
      apiLogger.warn({ msg: "check-in:qr-rejected", eventId, registrationId: registration.id, code: gate.code, kiosk: isKiosk });
      return NextResponse.json(
        {
          // The QR handler's historical wording for the cancelled case.
          error: gate.code === "CANCELLED" ? "Registration is cancelled" : gate.message,
          // Machine-readable code, mirroring the POST handler.
          code: gate.code,
          ...(gate.checkedInAt && { checkedInAt: gate.checkedInAt }),
          // The scanner UI shows who the badge belongs to on a double scan.
          ...(gate.code === "ALREADY_CHECKED_IN" && { registration }),
        },
        { status: 400 }
      );
    }

    const updatedRegistration = await executeCheckIn({
      eventId,
      registrationId: registration.id,
      actorUserId: session.user.id,
      attendeeName: `${registration.attendee.firstName} ${registration.attendee.lastName}`,
      source: "rest-qr",
      auditExtras: { qrCode, ip: getClientIp(req), ...(isKiosk && { kiosk: true }) },
    });

    return NextResponse.json(updatedRegistration);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error checking in by QR" });
    return NextResponse.json(
      { error: "Failed to check in" },
      { status: 500 }
    );
  }
}

// Undo a check-in (review H2) — clears status + checkedInAt together, so the
// attendee can be re-admitted by the scanner. This is the ONLY correct way to
// reverse a mistaken check-in; a bare status flip via the general registration
// PUT leaves checkedInAt set and locks them out permanently.
export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { eventId, registrationId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ONSITE (registration-desk staff) may undo a check-in they made.
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW, route: "events/[eventId]/registrations/[registrationId]/check-in:DELETE" });
    if (denied) return denied;

    return await runWithTenantLane(session.user.organizationId, { route: "registrations:check-in", userId: session.user.id }, async () => {
    const event = await db.event.findFirst({
      // Assignment-scoped for ONSITE — an ONSITE user may only act on events
      // they're assigned to. Org-scoped (unchanged) for admin/organizer.
      where: buildEventAccessWhere(session.user, eventId, { surface: "desk" }),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "check-in-undo:event-not-found", eventId, registrationId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const registration = await db.registration.findFirst({
      where: { id: registrationId, eventId },
      select: { id: true, attendee: { select: { firstName: true, lastName: true } } },
    });
    if (!registration) {
      apiLogger.warn({ msg: "check-in-undo:registration-not-found", eventId, registrationId, userId: session.user.id });
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const result = await undoCheckIn({
      eventId,
      registrationId,
      actorUserId: session.user.id,
      attendeeName: `${registration.attendee?.firstName ?? ""} ${registration.attendee?.lastName ?? ""}`.trim(),
      source: "rest",
      auditExtras: { ip: getClientIp(req) },
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.message, code: result.code }, { status: 409 });
    }

    return NextResponse.json(result.registration);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error undoing check-in" });
    return NextResponse.json({ error: "Failed to undo check-in" }, { status: 500 });
  }
}
