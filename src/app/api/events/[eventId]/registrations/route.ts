import { NextResponse } from "next/server";
import { z } from "zod";
import { PaymentStatus, RegistrationStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { generateBarcode, normalizeTag } from "@/lib/utils";
import { getNextSerialId } from "@/lib/registration-serial";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getOrgContext } from "@/lib/api-auth";
import { getClientIp } from "@/lib/security";
import { titleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";
import { notifyEventAdmins } from "@/lib/notifications";
import { refreshEventStats } from "@/lib/event-stats";

const registrationStatusSchema = z.nativeEnum(RegistrationStatus);
const paymentStatusSchema = z.nativeEnum(PaymentStatus);

// Admin-facing payment statuses. Stripe-driven states (PENDING / REFUNDED /
// FAILED) are excluded — they're set by the webhook, not by humans.
const manualPaymentStatusSchema = z.enum([
  "UNASSIGNED",
  "UNPAID",
  "PAID",
  "COMPLIMENTARY",
]);

const createRegistrationSchema = z.object({
  ticketTypeId: z.string().min(1).max(100).optional(),
  paymentStatus: manualPaymentStatusSchema.optional(),
  attendee: z.object({
    title: titleEnum.optional(),
    email: z.string().email().max(255),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    organization: z.string().max(255).optional(),
    jobTitle: z.string().max(255).optional(),
    phone: z.string().max(50).optional(),
    photo: z.string().max(500).optional(),
    city: z.string().max(255).optional(),
    country: z.string().max(255).optional(),
    bio: z.string().max(5000).optional(),
    specialty: z.string().max(255).optional(),
    tags: z.array(z.string().max(100).transform(normalizeTag)).optional(),
    dietaryReqs: z.string().max(2000).optional(),
    customFields: z.record(z.string().max(100), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).optional(),
  }),
  notes: z.string().max(2000).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, orgCtx] = await Promise.all([params, getOrgContext(req)]);

    if (!orgCtx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get("status");
    const paymentStatusParam = searchParams.get("paymentStatus");
    const parsedStatus = statusParam ? registrationStatusSchema.safeParse(statusParam) : null;
    const parsedPaymentStatus = paymentStatusParam ? paymentStatusSchema.safeParse(paymentStatusParam) : null;
    const status = parsedStatus?.success ? parsedStatus.data : undefined;
    const paymentStatus = parsedPaymentStatus?.success ? parsedPaymentStatus.data : undefined;
    const ticketTypeId = searchParams.get("ticketTypeId");

    // Parallelize event validation and registrations fetch
    const [event, registrations] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: orgCtx.organizationId,
        },
        select: { id: true },
      }),
      db.registration.findMany({
        where: {
          eventId,
          ...(status && { status }),
          ...(paymentStatus && { paymentStatus }),
          ...(ticketTypeId && { ticketTypeId }),
        },
        include: {
          attendee: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              title: true,
              phone: true,
              organization: true,
              jobTitle: true,
              city: true,
              country: true,
              photo: true,
              tags: true,
              dietaryReqs: true,
              specialty: true,
            },
          },
          ticketType: {
            select: {
              id: true,
              name: true,
              price: true,
              currency: true,
              quantity: true,
              soldCount: true,
            },
          },
          pricingTier: {
            select: {
              id: true,
              name: true,
              price: true,
              currency: true,
            },
          },
          payments: {
            select: {
              id: true,
              amount: true,
              currency: true,
              status: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
          accommodation: {
            select: {
              id: true,
              checkIn: true,
              checkOut: true,
              status: true,
              roomType: {
                select: {
                  name: true,
                  hotel: {
                    select: { name: true },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const response = NextResponse.json(registrations);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching registrations" });
    return NextResponse.json(
      { error: "Failed to fetch registrations" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request, { params }: RouteParams) {
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

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = createRegistrationSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { ticketTypeId, attendee, notes, paymentStatus: requestedPaymentStatus } = validated.data;

    // Look up event (always needed) and ticket type (if provided)
    const [event, ticketType] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId!,
        },
        select: { id: true },
      }),
      ticketTypeId
        ? db.ticketType.findFirst({
            where: { id: ticketTypeId, eventId, isActive: true },
            select: {
              id: true, name: true, price: true, currency: true,
              quantity: true, soldCount: true,
              salesStart: true, salesEnd: true, requiresApproval: true,
            },
          })
        : null,
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (ticketTypeId && !ticketType) {
      return NextResponse.json(
        { error: "Registration type not found or inactive" },
        { status: 404 }
      );
    }

    // Ticket type checks only when a type is selected
    if (ticketType) {
      const now = new Date();
      if (ticketType.salesStart && new Date(ticketType.salesStart) > now) {
        return NextResponse.json({ error: "Ticket sales have not started" }, { status: 400 });
      }
      if (ticketType.salesEnd && new Date(ticketType.salesEnd) < now) {
        return NextResponse.json({ error: "Ticket sales have ended" }, { status: 400 });
      }
      if (ticketType.soldCount >= ticketType.quantity) {
        return NextResponse.json({ error: "Tickets sold out" }, { status: 400 });
      }
    }

    // Atomic transaction: attendee create + duplicate check + soldCount increment + registration create
    const registration = await db.$transaction(async (tx) => {
      // Check if attendee already registered for this event (same email + same event)
      const existingRegistration = await tx.registration.findFirst({
        where: {
          eventId,
          attendee: { email: attendee.email },
          status: { notIn: ["CANCELLED"] },
        },
        select: { id: true },
      });
      if (existingRegistration) {
        throw new Error("ALREADY_REGISTERED");
      }

      // Create a new attendee record for this registration
      const attendeeRecord = await tx.attendee.create({
        data: {
          title: attendee.title || null,
          email: attendee.email,
          firstName: attendee.firstName,
          lastName: attendee.lastName,
          organization: attendee.organization || null,
          jobTitle: attendee.jobTitle || null,
          phone: attendee.phone || null,
          photo: attendee.photo || null,
          city: attendee.city || null,
          country: attendee.country || null,
          bio: attendee.bio || null,
          specialty: attendee.specialty || null,
          registrationType: ticketType?.name || null,
          tags: attendee.tags || [],
          dietaryReqs: attendee.dietaryReqs || null,
          customFields: attendee.customFields || {},
        },
      });

      // Atomically increment soldCount only when a ticket type is selected
      if (ticketType && ticketTypeId) {
        const updated = await tx.ticketType.updateMany({
          where: { id: ticketTypeId, soldCount: { lt: ticketType.quantity } },
          data: { soldCount: { increment: 1 } },
        });
        if (updated.count === 0) {
          throw new Error("SOLD_OUT");
        }
      }

      // Create registration
      const generatedBarcode = generateBarcode();
      const serialId = await getNextSerialId(tx, eventId);
      // Default: admin-created registrations start as UNASSIGNED for paid
      // tickets, COMPLIMENTARY for free. Admin can override with any of the
      // allowed manual statuses via input.paymentStatus.
      const defaultPaymentStatus = !ticketType || Number(ticketType.price) === 0
        ? "COMPLIMENTARY"
        : "UNASSIGNED";
      const reg = await tx.registration.create({
        data: {
          eventId,
          ticketTypeId: ticketTypeId || null,
          attendeeId: attendeeRecord.id,
          serialId,
          status: ticketType?.requiresApproval ? "PENDING" : "CONFIRMED",
          paymentStatus: requestedPaymentStatus ?? defaultPaymentStatus,
          qrCode: generatedBarcode,
          notes: notes || null,
        },
        include: { attendee: true, ticketType: true },
      });

      return reg;
    });

    // Sync to org contact store (awaited — errors caught internally)
    await syncToContact({
      organizationId: session.user.organizationId!,
      eventId,
      email: attendee.email,
      firstName: attendee.firstName,
      lastName: attendee.lastName,
      title: attendee.title || null,
      organization: attendee.organization || null,
      jobTitle: attendee.jobTitle || null,
      phone: attendee.phone || null,
      photo: attendee.photo || null,
      city: attendee.city || null,
      country: attendee.country || null,
      bio: attendee.bio || null,
      specialty: attendee.specialty || null,
      registrationType: ticketType?.name || null,
    });

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    // Log the action (non-blocking for better response time)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "Registration",
        entityId: registration.id,
        changes: { ...JSON.parse(JSON.stringify({ registration })), ip: getClientIp(req) },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    // Notify admins of new registration
    notifyEventAdmins(eventId, {
      type: "REGISTRATION",
      title: "Registration Added",
      message: `${attendee.firstName} ${attendee.lastName} added by ${session.user.firstName || "organizer"}`,
      link: `/events/${eventId}/registrations`,
    }).catch((err) => apiLogger.error({ err, msg: "Failed to send registration notification" }));

    return NextResponse.json(registration, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "ALREADY_REGISTERED") {
        return NextResponse.json(
          { error: "Attendee already registered for this event" },
          { status: 400 }
        );
      }
      if (error.message === "SOLD_OUT") {
        return NextResponse.json(
          { error: "Tickets sold out" },
          { status: 400 }
        );
      }
    }
    apiLogger.error({ err: error, msg: "Error creating registration" });
    return NextResponse.json(
      { error: "Failed to create registration" },
      { status: 500 }
    );
  }
}
