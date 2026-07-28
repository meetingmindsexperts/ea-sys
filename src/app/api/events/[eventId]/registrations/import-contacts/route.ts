import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db, tenantTransaction } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { recordImport } from "@/lib/audit-data-transfer";
import { getNextSerialId } from "@/lib/registration-serial";
import { incrementEventSeatsOverselling } from "@/lib/registration-seat-db";
import { resolveImportFallbackTicketType } from "@/lib/import-ticket-type";

type RouteParams = { params: Promise<{ eventId: string }> };

const importSchema = z.object({
  contactIds: z.array(z.string()).min(1),
  // Optional since July 28, 2026 — mirrors the CSV importer's "never guess"
  // rule: absent ⇒ rows import uncategorised (ticketTypeId null) and get a
  // type later via bulk Change Type / Send Registration Forms. Faculty types
  // are refused by resolveImportFallbackTicketType.
  ticketTypeId: z.string().min(1).optional(),
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

    // A tier belongs to a type — a tier with no type is a client bug, not
    // "price the typeless rows anyway".
    if (pricingTierId && !ticketTypeId) {
      apiLogger.warn({ msg: "import-contacts:tier-without-type", eventId, pricingTierId });
      return NextResponse.json(
        { error: "A pricing tier requires a registration type.", code: "TIER_WITHOUT_TYPE" },
        { status: 400 }
      );
    }

    // Verify event and fetch contacts — the FULL person shape, so nothing the
    // org already knows about the contact is silently dropped on import.
    const [event, contacts] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: orgGuard.orgId },
        select: { id: true },
      }),
      db.contact.findMany({
        where: { id: { in: contactIds }, organizationId: orgGuard.orgId },
        select: {
          email: true,
          firstName: true,
          lastName: true,
          title: true,
          role: true,
          organization: true,
          jobTitle: true,
          phone: true,
          additionalEmail: true,
          bio: true,
          specialty: true,
          customSpecialty: true,
          registrationType: true,
          photo: true,
          city: true,
          state: true,
          zipCode: true,
          country: true,
          associationName: true,
          memberId: true,
          studentId: true,
          studentIdExpiry: true,
          tags: true,
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Resolve the (optional) registration type through the shared import
    // helper — enforces event membership and refuses faculty types (the
    // hidden speaker-companion type must never receive imported delegates).
    // Absent ⇒ null ⇒ rows import uncategorised, never a guessed type.
    const typeResult = await resolveImportFallbackTicketType(eventId, ticketTypeId);
    if (!typeResult.ok) {
      apiLogger.warn({ msg: "import-contacts:ticket-type-rejected", eventId, ticketTypeId, code: typeResult.code });
      return NextResponse.json({ error: typeResult.message, code: typeResult.code }, { status: 400 });
    }
    const ticketType = typeResult.ticketType;

    // Resolve the optional pricing tier — must belong to the chosen ticket
    // type. Like the manual Add-Registration form, an inactive tier is
    // allowed (courtesy pricing); we only enforce membership. The tier's
    // price becomes the stamped originalPrice; without a tier we fall back
    // to the ticket type's base price.
    let tier: { id: string; price: unknown } | null = null;
    if (pricingTierId && ticketType) {
      tier = await db.pricingTier.findFirst({
        where: { id: pricingTierId, ticketTypeId: ticketType.id },
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
    // Uncategorised rows have no price to stamp — originalPrice stays null
    // until a type is assigned (bulk Change Type / completion form).
    const originalPrice = ticketType ? Number(tier ? tier.price : ticketType.price) : null;

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
              organizationId: orgGuard.orgId,
              email: contact.email,
              firstName: contact.firstName,
              lastName: contact.lastName,
              title: contact.title ?? undefined,
              role: contact.role ?? undefined,
              organization: contact.organization ?? undefined,
              jobTitle: contact.jobTitle ?? undefined,
              phone: contact.phone ?? undefined,
              additionalEmail: contact.additionalEmail ?? undefined,
              bio: contact.bio ?? undefined,
              specialty: contact.specialty ?? undefined,
              customSpecialty: contact.customSpecialty ?? undefined,
              photo: contact.photo ?? undefined,
              city: contact.city ?? undefined,
              state: contact.state ?? undefined,
              zipCode: contact.zipCode ?? undefined,
              country: contact.country ?? undefined,
              associationName: contact.associationName ?? undefined,
              memberId: contact.memberId ?? undefined,
              studentId: contact.studentId ?? undefined,
              studentIdExpiry: contact.studentIdExpiry ?? undefined,
              tags: contact.tags ?? [],
              // ticketTypeId is the source of truth; this free-text mirror
              // shows the picked type's name, falling back to the contact's
              // own recorded category for uncategorised rows.
              registrationType: ticketType?.name ?? contact.registrationType ?? undefined,
            },
          });

          const serialId = await getNextSerialId(tx, eventId, orgGuard.orgId);
          await tx.registration.create({
            data: {
              organizationId: orgGuard.orgId,
              eventId,
              ticketTypeId: ticketType?.id ?? null,
              pricingTierId: tier?.id ?? null,
              attendeeId: attendee.id,
              serialId,
              // Stamp the price at create so finance surfaces resolve it
              // tier-aware (closes the deferred "unstamped import path").
              // Uncategorised rows have no price → stays null.
              originalPrice,
              // No ticket type ⇒ nothing is owed (there is no price to owe):
              // explicit COMPLIMENTARY, exactly like the CSV importer's
              // typeless rows. Typed rows keep the pre-existing defaults
              // (owner declined the defaults-parity change, July 28, 2026).
              ...(ticketType ? {} : { paymentStatus: "COMPLIMENTARY" as const }),
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
        // Uncategorised rows have no ticket-type counter to move (seatCounter
        // agrees) — the event-wide counter below still counts them.
        if (ticketType) {
          const claimed = await tx.ticketType.updateMany({
            where: { id: ticketType.id, soldCount: { lte: ticketType.quantity - toCreate.length } },
            data: { soldCount: { increment: toCreate.length } },
          });
          if (claimed.count === 0) {
            throw new Error("CAPACITY_EXCEEDED");
          }
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

    recordImport(req, {
      entityType: "Registration",
      eventId,
      organizationId: session.user.organizationId,
      userId: session.user.id,
      role: session.user.role,
      totalProcessed: contacts.length,
      created: toCreate.length,
      skipped,
      format: "contacts",
    });

    return NextResponse.json({
      created: toCreate.length,
      skipped,
      // Mirrors the CSV importer's report shape: rows imported without a
      // registration type (all-or-none here — one picker covers the batch).
      uncategorised: ticketType ? 0 : toCreate.length,
    });
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
