import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db, tenantTransaction } from "@/lib/db";
import { exhibitorBadgeData } from "@/lib/badge-layout";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { refreshEventStats } from "@/lib/event-stats";
import { planSeatTransition, type SeatCounter } from "@/lib/registration-seat";
import { claimEventSeats, claimSeats, releaseEventSeats, releaseSeats } from "@/lib/registration-seat-db";
import { lockRegistrationRows } from "@/lib/registration-row-lock";
import { pickOpenPublicRate } from "@/lib/current-pricing-tier";
import { readCodeRequiredTiers } from "@/lib/code-required-tiers";
import { linkRatePrice } from "@/lib/registration-form-pricing";

const UNPAID_STATUSES = ["UNASSIGNED", "UNPAID", "PENDING"];

const bulkTypeSchema = z.object({
  registrationIds: z.array(z.string()).min(1).max(500),
  ticketTypeId: z.string().min(1),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams) {
  // Resolved before the try so eventId is in scope for the catch's logs.
  const { eventId } = await params;
  try {
    const [session, body] = await Promise.all([
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/registrations/bulk-type:PATCH" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "registrations.bulk", { route: "events/[eventId]/registrations/bulk-type:PATCH", eventId });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true, settings: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const validated = bulkTypeSchema.safeParse(body);
    if (!validated.success) {
        apiLogger.warn({ msg: "events/registrations/bulk-type:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { registrationIds, ticketTypeId } = validated.data;

    // Verify the target ticket type exists and belongs to this event
    const targetType = await db.ticketType.findFirst({
      where: { id: ticketTypeId, eventId },
      select: {
        id: true, name: true, quantity: true, price: true, virtualPrice: true, isFaculty: true,
        pricingTiers: {
          select: { id: true, name: true, price: true, currency: true, quantity: true, soldCount: true, isActive: true, salesStart: true, salesEnd: true, sortOrder: true },
        },
      },
    });

    if (!targetType) {
      apiLogger.warn({ msg: "registrations/bulk-type:type-not-found", eventId, ticketTypeId });
      return NextResponse.json({ error: "Registration type not found" }, { status: 404 });
    }
    // Never onto the speakers' type (Oct 22, 2026, review M): same rule as
    // create and the single edit.
    if (targetType.isFaculty) {
      apiLogger.warn({ msg: "registrations/bulk-type:target-is-faculty", eventId, ticketTypeId, count: registrationIds.length });
      return NextResponse.json(
        { error: "The speakers' Faculty type is reserved for speakers and is set automatically. Pick a delegate type.", code: "TICKET_TYPE_IS_FACULTY" },
        { status: 400 },
      );
    }

    // The rate an unpaid row moves onto: the type's open public rate, the same
    // one the completion form gives (pickOpenPublicRate), never a sponsor-link
    // or presenter rate (Nov 9, 2026 review). It used to be the type's BASE
    // price with the rate dropped, and the standard setup keeps the base at 0
    // with the money on the rates: an imported row bulk-typed onto Physician
    // (base 0, Standard 250) owed 0.00, was admitted as free and was still
    // sent a "pay 0.00" reminder. A type with rates but none on sale refuses
    // the unpaid rows instead of pricing them at the base.
    const { tier: openRate, noRateOnSale } = pickOpenPublicRate(
      targetType.pricingTiers,
      readCodeRequiredTiers(event.settings),
      new Date(),
    );

    // Everything below is decided from the rows as they stand INSIDE the
    // transaction, locked (review, Oct 29 2026): read before it, a cancel or a
    // single edit landing in between was overwritten, and a cancelled row was
    // released a second time, then moved onto the new type holding a seat.
    const registrations = await tenantTransaction(async (tx) => {
      // Lock order, shared with every single-row path: the registration rows
      // first (by id, so two bulk moves cannot cross), then the seat counters
      // (type before tier, registration-seat-db.ts).
      await lockRegistrationRows(tx, eventId, registrationIds);

      // The rows being moved: not cancelled, not already this type. A row with
      // no type is moved too: `not` alone excludes NULL in SQL, which left
      // every uncategorised row (Import from Contacts without a type) unmovable.
      const moving = await tx.registration.findMany({
        where: {
          id: { in: registrationIds },
          eventId,
          status: { not: "CANCELLED" },
          OR: [{ ticketTypeId: null }, { ticketTypeId: { not: ticketTypeId } }],
        },
        select: {
          id: true,
          ticketTypeId: true,
          attendeeId: true,
          pricingTierId: true,
          createdSource: true,
          attendanceMode: true,
          status: true,
          paymentStatus: true,
        },
      });
      if (moving.length === 0) return moving;

      const unpaid = moving.filter((r) => UNPAID_STATUSES.includes(r.paymentStatus));
      const settled = moving.filter((r) => !UNPAID_STATUSES.includes(r.paymentStatus));
      if (unpaid.length > 0 && noRateOnSale) throw new Error("NO_RATE_ON_SALE");
      const unpaidIdSet = new Set(unpaid.map((r) => r.id));

      // Each row's seat move, from the ONE planner every single-row path uses
      // (planSeatTransition): the counter it releases, the one it claims, and
      // whether it gains or loses its event seat. A row with no type holds no
      // seat anywhere and gains both; a speaker's companion stays on no counter
      // (review of 8740deeb: hand-rolled counting missed both).
      const ops = new Map<string, { counter: SeatCounter; delta: number }>();
      let eventDelta = 0;
      for (const r of moving) {
        // An unpaid row takes the open rate, so its seat is claimed on it too.
        const targetTierId = unpaidIdSet.has(r.id) ? (openRate?.id ?? null) : null;
        const plan = planSeatTransition(r, { ...r, ticketTypeId, pricingTierId: targetTierId });
        for (const [counter, step] of [[plan.release, -1], [plan.claim, 1]] as const) {
          if (!counter) continue;
          const key = `${counter.kind}:${counter.id}`;
          const entry = ops.get(key) ?? { counter, delta: 0 };
          entry.delta += step;
          ops.set(key, entry);
        }
        eventDelta += plan.eventDelta;
      }

      // Counters in one sorted order, releases and claims together, so two bulk
      // moves in opposite directions cannot take them in opposite orders; then
      // the event seat (the phase order applyRegistrationTransition uses). Not a
      // global order: a single edit moving A→B against a bulk B→A can still
      // collide, which Postgres ends by aborting one (40P01), never by
      // miscounting. The claim is all-or-nothing: if it can't fit, the whole
      // move rolls back.
      for (const [, { counter, delta }] of [...ops].sort(([a], [b]) => a.localeCompare(b))) {
        if (delta < 0) await releaseSeats(tx, counter, -delta);
        if (delta > 0 && !(await claimSeats(tx, counter, delta))) throw new Error("CAPACITY_EXCEEDED");
      }
      if (eventDelta < 0) await releaseEventSeats(tx, eventId, -eventDelta);
      if (eventDelta > 0 && !(await claimEventSeats(tx, eventId, eventDelta))) throw new Error("EVENT_FULL");

      // Update all registrations. Unpaid rows (UNASSIGNED/UNPAID/PENDING) are
      // RE-STAMPED at the open rate (review H8: readRegistrationBasePrice
      // prefers the stamped originalPrice, so without it a $100-Student reg
      // bulk-moved to $400-Physician kept charging $100); a virtual attendee
      // pays the type's virtual price. Settled rows (PAID/COMPLIMENTARY/
      // INCLUSIVE/...) move type but keep their price and drop the old rate:
      // they already paid it. Grouped by price, because virtual and in-person
      // rows on the same type can owe different amounts. The rows are locked,
      // so writing by id is writing exactly what was read.
      const byPrice = new Map<number, string[]>();
      for (const r of unpaid) {
        const price = linkRatePrice(Number(openRate?.price ?? targetType.price), {
          isVirtual: r.attendanceMode === "VIRTUAL",
          virtualPrice: targetType.virtualPrice,
        });
        byPrice.set(price, [...(byPrice.get(price) ?? []), r.id]);
      }
      for (const [price, ids] of byPrice) {
        await tx.registration.updateMany({
          where: { id: { in: ids }, eventId },
          data: { ticketTypeId, ...exhibitorBadgeData(targetType.name), pricingTierId: openRate?.id ?? null, originalPrice: price },
        });
      }
      if (settled.length > 0) {
        await tx.registration.updateMany({
          where: { id: { in: settled.map((r) => r.id) }, eventId },
          data: { ticketTypeId, ...exhibitorBadgeData(targetType.name), pricingTierId: null },
        });
      }

      // Sync attendee.registrationType
      await tx.attendee.updateMany({
        where: { id: { in: moving.map((r) => r.attendeeId) } },
        data: { registrationType: targetType.name },
      });
      return moving;
    });

    if (registrations.length === 0) {
      return NextResponse.json({ updated: 0 });
    }

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    // Audit log (non-blocking)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "Registration",
        entityId: "bulk",
        changes: {
          bulkTypeChange: {
            registrationIds: registrations.map((r) => r.id),
            toTicketTypeId: ticketTypeId,
            toName: targetType.name,
            count: registrations.length,
            // Unpaid rows re-stamped at the open rate (H8; virtual at the
            // virtual price); settled rows kept their paid price.
            repricedCount: registrations.filter((r) => UNPAID_STATUSES.includes(r.paymentStatus)).length,
            repricedRate: openRate?.name ?? null,
            repricedTo: Number(openRate?.price ?? targetType.price),
            virtualPrice: targetType.virtualPrice == null ? null : Number(targetType.virtualPrice),
          },
          ip: getClientIp(req),
        },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    apiLogger.info({
      msg: "Bulk registration type update",
      eventId,
      ticketTypeId,
      count: registrations.length,
      userId: session.user.id,
    });

    return NextResponse.json({ updated: registrations.length });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "NO_RATE_ON_SALE") {
      apiLogger.warn({ msg: "bulk-type:no-rate-on-sale", eventId });
      return NextResponse.json(
        {
          error: "That registration type has rates but none is on sale now, so the unpaid registrations cannot be priced. Open a rate, or move only paid registrations.",
          code: "NO_RATE_ON_SALE",
        },
        { status: 409 }
      );
    }
    if (error instanceof Error && error.message === "EVENT_FULL") {
      apiLogger.warn({ msg: "bulk-type:event-full", eventId });
      return NextResponse.json(
        {
          error: "The event has reached its maximum number of attendees. Raise the cap in Settings → Registration, or move fewer.",
          code: "EVENT_FULL",
        },
        { status: 409 }
      );
    }
    if (error instanceof Error && error.message === "CAPACITY_EXCEEDED") {
      apiLogger.warn({ msg: "bulk-type:capacity-exceeded", eventId });
      return NextResponse.json(
        {
          error: "That registration type doesn't have enough capacity for all the selected registrations. Increase its quantity or move fewer.",
          code: "CAPACITY_EXCEEDED",
        },
        { status: 409 }
      );
    }
    apiLogger.error({ err: error, msg: "Error in bulk type update" });
    return NextResponse.json(
      { error: "Failed to update registration types" },
      { status: 500 }
    );
  }
}
