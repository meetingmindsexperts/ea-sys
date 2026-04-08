import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";
import { notifyEventAdmins } from "@/lib/notifications";

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { eventId, registrationId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId!,
      },
      select: { id: true },
    });

    if (!event) {
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
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    if (registration.status === "CANCELLED") {
      return NextResponse.json(
        { error: "Cannot check in a cancelled registration" },
        { status: 400 }
      );
    }

    // Block check-in for unpaid registrations (unless complimentary)
    const isComplimentary = registration.paymentStatus === "COMPLIMENTARY" ||
      Number(registration.ticketType?.price ?? 0) === 0 ||
      (registration.pricingTier && Number(registration.pricingTier.price) === 0);
    if (!isComplimentary && (registration.paymentStatus === "UNPAID" || registration.paymentStatus === "PENDING")) {
      return NextResponse.json(
        { error: "Cannot check in — payment required" },
        { status: 400 }
      );
    }

    if (registration.checkedInAt) {
      return NextResponse.json(
        { error: "Already checked in", checkedInAt: registration.checkedInAt },
        { status: 400 }
      );
    }

    const updatedRegistration = await db.registration.update({
      where: { id: registrationId },
      data: {
        status: "CHECKED_IN",
        checkedInAt: new Date(),
      },
      include: {
        attendee: true,
        ticketType: true,
      },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CHECK_IN",
        entityType: "Registration",
        entityId: registrationId,
        changes: {
          checkedInAt: updatedRegistration.checkedInAt,
          attendeeName: `${registration.attendee.firstName} ${registration.attendee.lastName}`,
          ip: getClientIp(req),
        },
      },
    });

    // Notify admins/organizers (non-blocking)
    notifyEventAdmins(eventId, {
      type: "CHECK_IN",
      title: "Attendee Checked In",
      message: `${registration.attendee.firstName} ${registration.attendee.lastName} checked in`,
      link: `/events/${eventId}/check-in`,
    }).catch((err) => apiLogger.error({ err, msg: "Failed to send check-in notification" }));

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

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId!,
      },
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json();
    const { qrCode } = body;

    if (!qrCode) {
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
      return NextResponse.json({ error: "Invalid code — not found" }, { status: 404 });
    }

    if (registration.status === "CANCELLED") {
      return NextResponse.json(
        { error: "Registration is cancelled" },
        { status: 400 }
      );
    }

    // Block check-in for unpaid registrations (unless complimentary)
    const isComplimentary = registration.paymentStatus === "COMPLIMENTARY" ||
      Number(registration.ticketType?.price ?? 0) === 0 ||
      (registration.pricingTier && Number(registration.pricingTier.price) === 0);
    if (!isComplimentary && (registration.paymentStatus === "UNPAID" || registration.paymentStatus === "PENDING")) {
      return NextResponse.json(
        { error: "Cannot check in — payment required" },
        { status: 400 }
      );
    }

    if (registration.checkedInAt) {
      return NextResponse.json(
        {
          error: "Already checked in",
          checkedInAt: registration.checkedInAt,
          registration,
        },
        { status: 400 }
      );
    }

    const updatedRegistration = await db.registration.update({
      where: { id: registration.id },
      data: {
        status: "CHECKED_IN",
        checkedInAt: new Date(),
      },
      include: {
        attendee: true,
        ticketType: true,
      },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CHECK_IN",
        entityType: "Registration",
        entityId: registration.id,
        changes: {
          checkedInAt: updatedRegistration.checkedInAt,
          attendeeName: `${registration.attendee.firstName} ${registration.attendee.lastName}`,
          qrCode,
          ip: getClientIp(req),
        },
      },
    });

    // Notify admins/organizers (non-blocking)
    notifyEventAdmins(eventId, {
      type: "CHECK_IN",
      title: "Attendee Checked In",
      message: `${registration.attendee.firstName} ${registration.attendee.lastName} checked in`,
      link: `/events/${eventId}/check-in`,
    }).catch((err) => apiLogger.error({ err, msg: "Failed to send check-in notification" }));

    return NextResponse.json(updatedRegistration);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error checking in by QR" });
    return NextResponse.json(
      { error: "Failed to check in" },
      { status: 500 }
    );
  }
}
