import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, REGISTRATION_DESK_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { checkInGate, executeCheckIn, undoCheckIn } from "@/lib/check-in";

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
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW });
    if (denied) return denied;

    const event = await db.event.findFirst({
      // Assignment-scoped for ONSITE (per-event desk staff) — an ONSITE user may
      // only check in attendees for events they're assigned to. Org-scoped
      // (unchanged) for admin/organizer.
      where: buildEventAccessWhere(session.user, eventId),
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

    const gate = checkInGate({
      status: registration.status,
      paymentStatus: registration.paymentStatus,
      checkedInAt: registration.checkedInAt,
      ticketTypePrice: registration.ticketType?.price,
      pricingTierPrice: registration.pricingTier?.price,
    });
    if (gate) {
      apiLogger.warn({ msg: "check-in:rejected", eventId, registrationId, code: gate.code });
      return NextResponse.json(
        {
          error: gate.code === "CANCELLED" ? "Cannot check in a cancelled registration" : gate.message,
          ...(gate.checkedInAt && { checkedInAt: gate.checkedInAt }),
        },
        { status: 400 }
      );
    }

    const updatedRegistration = await executeCheckIn({
      eventId,
      registrationId,
      actorUserId: session.user.id,
      attendeeName: `${registration.attendee.firstName} ${registration.attendee.lastName}`,
      source: "rest",
      auditExtras: { ip: getClientIp(req) },
    });

    return NextResponse.json(updatedRegistration);
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
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW });
    if (denied) return denied;

    const event = await db.event.findFirst({
      // Assignment-scoped for ONSITE (per-event desk staff) — an ONSITE user may
      // only check in attendees for events they're assigned to. Org-scoped
      // (unchanged) for admin/organizer.
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });

    if (!event) {
      apiLogger.warn({ msg: "check-in-qr:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json();
    const { qrCode } = body;

    if (!qrCode) {
      apiLogger.warn({ msg: "check-in-qr:missing-code", eventId, userId: session.user.id });
      return NextResponse.json({ error: "QR code or barcode required" }, { status: 400 });
    }

    // Search by qrCode OR dtcmBarcode
    const registration = await db.registration.findFirst({
      where: {
        eventId,
        OR: [
          { qrCode },
          { dtcmBarcode: qrCode },
        ],
      },
      include: {
        attendee: true,
        ticketType: { select: { name: true, price: true } },
        pricingTier: { select: { price: true } },
      },
    });

    if (!registration) {
      // H5: the unknown-barcode scan is the single highest-value line to trace
      // at a live door ("why didn't that badge scan?") — a wrong-event badge, a
      // mis-print, or a probing/forged code. It logged nothing before.
      apiLogger.warn({ msg: "check-in:qr-unknown-code", eventId, userId: session.user.id }, "Scanned code matched no registration");
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
      apiLogger.warn({ msg: "check-in:qr-rejected", eventId, registrationId: registration.id, code: gate.code });
      return NextResponse.json(
        {
          // The QR handler's historical wording for the cancelled case.
          error: gate.code === "CANCELLED" ? "Registration is cancelled" : gate.message,
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
      auditExtras: { qrCode, ip: getClientIp(req) },
    });

    return NextResponse.json(updatedRegistration);
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
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW });
    if (denied) return denied;

    const event = await db.event.findFirst({
      // Assignment-scoped for ONSITE — an ONSITE user may only act on events
      // they're assigned to. Org-scoped (unchanged) for admin/organizer.
      where: buildEventAccessWhere(session.user, eventId),
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
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error undoing check-in" });
    return NextResponse.json({ error: "Failed to undo check-in" }, { status: 500 });
  }
}
