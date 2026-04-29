import { NextResponse } from "next/server";
import { z } from "zod";
import { PaymentStatus, RegistrationStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeTag } from "@/lib/utils";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getOrgContext } from "@/lib/api-auth";
import { getClientIp } from "@/lib/security";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";
import {
  createRegistration,
  type CreateRegistrationErrorCode,
} from "@/services/registration-service";

// HTTP status mapping for the service's domain error codes. Compile-time
// exhaustive via `Record<CreateRegistrationErrorCode, number>`.
const HTTP_STATUS_FOR_REGISTRATION_ERROR: Record<CreateRegistrationErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  TICKET_TYPE_NOT_FOUND: 404,
  SALES_NOT_STARTED: 400,
  SALES_ENDED: 400,
  SOLD_OUT: 400,
  PRICING_TIER_NOT_FOUND: 404,
  ALREADY_REGISTERED: 400,
  INVALID_PAYMENT_STATUS: 400,
  UNKNOWN: 500,
};

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
    // Demographic / professional classification — the public form collects
    // this; admin create must accept it too. Same enum the public path uses.
    role: attendeeRoleEnum.optional(),
    email: z.string().email().max(255),
    // Secondary email for registrants who want notifications cc'd (e.g.
    // personal + work). Public register accepts it; admin create must too.
    additionalEmail: z.string().email().max(255).optional().or(z.literal("")),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    organization: z.string().max(255).optional(),
    jobTitle: z.string().max(255).optional(),
    phone: z.string().max(50).optional(),
    photo: z.string().max(500).optional(),
    city: z.string().max(255).optional(),
    state: z.string().max(255).optional(),
    zipCode: z.string().max(20).optional(),
    country: z.string().max(255).optional(),
    bio: z.string().max(5000).optional(),
    specialty: z.string().max(255).optional(),
    // Free-text when specialty is "Others" — parity with public register.
    customSpecialty: z.string().max(255).optional(),
    tags: z.array(z.string().max(100).transform(normalizeTag)).optional(),
    dietaryReqs: z.string().max(2000).optional(),
    // Membership / student registration fields — conditionally required on
    // the public form based on the registration type name. Admin create
    // accepts them unconditionally; organizer is trusted to verify the IDs.
    associationName: z.string().max(255).optional(),
    memberId: z.string().max(100).optional(),
    studentId: z.string().max(100).optional(),
    // ISO 8601 date string (YYYY-MM-DD). Coerced to Date in the service.
    studentIdExpiry: z.string().max(20).optional(),
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
              // Card + method-type details surface in the Billing tab
              // for both Stripe and manual payments. Receipt URL points
              // either at Stripe's hosted receipt OR an organizer-
              // uploaded proof for manual transfers. Metadata carries
              // the manual reconciliation fields (bankReference,
              // cashReceivedBy, notes).
              cardBrand: true,
              cardLast4: true,
              paymentMethodType: true,
              paidAt: true,
              receiptUrl: true,
              metadata: true,
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
        apiLogger.warn({ msg: "events/registrations:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { ticketTypeId, attendee, notes, paymentStatus: requestedPaymentStatus } = validated.data;

    const result = await createRegistration({
      eventId,
      organizationId: session.user.organizationId!,
      userId: session.user.id,
      ticketTypeId,
      attendee,
      notes,
      paymentStatus: requestedPaymentStatus,
      source: "rest",
      requestIp: getClientIp(req),
      actorFirstName: session.user.firstName ?? null,
    });

    if (!result.ok) {
      const status = HTTP_STATUS_FOR_REGISTRATION_ERROR[result.code] ?? 500;
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.meta ?? {}) },
        { status },
      );
    }

    return NextResponse.json(result.registration, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating registration" });
    return NextResponse.json(
      { error: "Failed to create registration" },
      { status: 500 }
    );
  }
}
