import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db, tenantTransaction } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { getNextSerialId } from "@/lib/registration-serial";
import { incrementEventSeatsOverselling } from "@/lib/registration-seat-db";

type RouteParams = { params: Promise<{ eventId: string }> };

const importSchema = z.object({
  contactIds: z.array(z.string()).min(1),
  ticketTypeId: z.string().min(1),
  // Optional pricing tier (only meaningful when the chosen ticket type has
  // tiers). Validated below to belong to the ticket type; drives the stamped
  // originalPrice + pricingTierId so finance surfaces price these correctly.
  pricingTierId: z.string().min(1).optional(),
});

export async function POST(req: Request, { params }: RouteParams) {
  // Resolved before the try so eventId is in scope for the catch's logs.
  const { eventId } = await params;
  try {
    const [session, body] = await Promise.all([auth(), req.json()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = importSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "events/registrations/import-contacts:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const { contactIds, ticketTypeId, pricingTierId } = validated.data;

    // Verify event, ticket type, and fetch contacts
    const [event, ticketType, contacts] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: orgGuard.orgId },
        select: { id: true },
      }),
      db.ticketType.findFirst({
        where: { id: ticketTypeId, eventId },
        select: { id: true, soldCount: true, quantity: true, price: true },
      }),
      db.contact.findMany({
        where: { id: { in: contactIds }, organizationId: orgGuard.orgId },
        select: { email: true, firstName: true, lastName: true, organization: true, jobTitle: true, phone: true, role: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!ticketType) {
      return NextResponse.json({ error: "Ticket type not found" }, { status: 404 });
    }

    // Resolve the optional pricing tier — must belong to the chosen ticket
    // type. Like the manual Add-Registration form, an inactive tier is
    // allowed (courtesy pricing); we only enforce membership. The tier's
    // price becomes the stamped originalPrice; without a tier we fall back
    // to the ticket type's base price.
    let tier: { id: string; price: unknown } | null = null;
    if (pricingTierId) {
      tier = await db.pricingTier.findFirst({
        where: { id: pricingTierId, ticketTypeId },
        select: { id: true, price: true },
      });
      if (!tier) {
        apiLogger.warn({ msg: "import-contacts:pricing-tier-not-found", eventId, ticketTypeId, pricingTierId });
        return NextResponse.json(
          { error: "The selected pricing tier doesn't belong to that registration type.", code: "PRICING_TIER_NOT_FOUND" },
          { status: 400 }
        );
      }
    }
    const originalPrice = Number(tier ? tier.price : ticketType.price);

    // Find existing registrations for this event by attendee email
    const existingAttendees = await db.attendee.findMany({
      where: {
        email: { in: contacts.map((c) => c.email) },
        registrations: { some: { eventId } },
      },
      select: { email: true },
    });

    const existingEmails = new Set(existingAttendees.map((a) => a.email));
    const toCreate = contacts.filter((c) => !existingEmails.has(c.email));
    const skipped = contacts.length - toCreate.length;

    if (toCreate.length > 0) {
      // Create attendees and registrations in a transaction.
      // tenantTransaction (tenancy pilot): identical to db.$transaction while
      // RLS_SET_LOCAL is off; on an RLS deployment it pins the tx to the org.
      await tenantTransaction(async (tx) => {
        for (const contact of toCreate) {
          const attendee = await tx.attendee.create({
            data: {
              email: contact.email,
              firstName: contact.firstName,
              lastName: contact.lastName,
              organization: contact.organization ?? undefined,
              jobTitle: contact.jobTitle ?? undefined,
              phone: contact.phone ?? undefined,
              role: contact.role ?? undefined,
            },
          });

          const serialId = await getNextSerialId(tx, eventId);
          await tx.registration.create({
            data: {
              eventId,
              ticketTypeId,
              pricingTierId: tier?.id ?? null,
              attendeeId: attendee.id,
              serialId,
              // Stamp the price at create so finance surfaces resolve it
              // tier-aware (closes the deferred "unstamped import path").
              originalPrice,
              // "Import from Contacts" is admin-driven — operator
              // picks a checked subset and imports as registrations.
              // Not a CSV upload, so ADMIN_DASHBOARD is the right
              // bucket (organizer manually chose each row).
              createdSource: "ADMIN_DASHBOARD",
            },
          });
        }

        // Update soldCount ATOMICALLY — guard against oversell. The predicate
        // `soldCount <= quantity - N` ensures soldCount + N never exceeds the
        // cap even under a concurrent import / public registration. All-or-
        // nothing: if the batch won't fit, the whole tx rolls back (no rows
        // created) and the operator imports fewer or raises the quantity.
        const claimed = await tx.ticketType.updateMany({
          where: { id: ticketTypeId, soldCount: { lte: ticketType.quantity - toCreate.length } },
          data: { soldCount: { increment: toCreate.length } },
        });
        if (claimed.count === 0) {
          throw new Error("CAPACITY_EXCEEDED");
        }
        // Event-wide cap: imports BYPASS the cap (owner decision July 24, 2026)
        // — unguarded increment, warn when over.
        const eventSeat = await incrementEventSeatsOverselling(tx, eventId, toCreate.length);
        if (eventSeat.oversold) {
          apiLogger.warn({
            msg: "import:event-oversold",
            eventId,
            newSeatCount: eventSeat.newSeatCount,
            maxAttendees: eventSeat.maxAttendees,
            source: "import-contacts",
          });
        }
      });
    }

    return NextResponse.json({ created: toCreate.length, skipped });
  } catch (error) {
    if (error instanceof Error && error.message === "CAPACITY_EXCEEDED") {
      apiLogger.warn({ msg: "import-contacts:capacity-exceeded", eventId });
      return NextResponse.json(
        {
          error: "That registration type doesn't have enough capacity for all the selected contacts. Increase its quantity or import fewer.",
          code: "CAPACITY_EXCEEDED",
        },
        { status: 409 }
      );
    }
    apiLogger.error({ err: error, msg: "Error importing contacts as registrations" });
    return NextResponse.json({ error: "Failed to import contacts" }, { status: 500 });
  }
}
