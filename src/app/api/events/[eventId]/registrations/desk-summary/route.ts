import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { eventWhereFor } from "@/lib/permissions/can";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenant } from "@/lib/tenant-context";
import { localDateInTz, resolveTimezone } from "@/lib/event-time";
import { readRegistrationBasePrice } from "@/lib/registration-financials";
import {
  DESK_PAYMENT_METHODS,
  deskDayBounds,
  isDeskDate,
  summariseDeskDay,
  type DeskPaymentMethod,
} from "@/lib/desk-day-summary";

/**
 * GET /api/events/[eventId]/registrations/desk-summary?date=YYYY-MM-DD
 *
 * The desk's day summary (owner, Nov 2, 2026; docs/ONSITE_DESK_PLAN.md): the
 * walk-ins registered that day by rate (Free, Comp, Sponsor, Paid), and the
 * cash and onsite card recorded that day, per desk user. The day is a calendar
 * day in the event's timezone, today when no date is given.
 *
 * Whoever records payments may open it. What they see (owner): a manager, who
 * holds `payments.refund` on this event, sees every desk user; anyone else sees
 * only the walk-ins they registered and the money they took. The money is ALL
 * desk cash and card for the event, walk-ins or not, so it matches the drawer:
 * people who registered online and paid at the desk are in it. A payment
 * counts on the day it was recorded, which is when it reached the drawer.
 */

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const ROUTE = "events/[eventId]/registrations/desk-summary:GET";

export async function GET(req: Request, { params }: RouteParams) {
  const { eventId } = await params;
  try {
    const session = await auth();
    if (!session?.user) {
      apiLogger.warn({ msg: "desk-summary:unauthenticated", eventId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE, eventId });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "payments.record", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    const requested = new URL(req.url).searchParams.get("date");
    if (requested !== null && !isDeskDate(requested)) {
      apiLogger.warn({ msg: "desk-summary:bad-date", eventId, date: requested, userId: session.user.id });
      return NextResponse.json({ error: "The date must be YYYY-MM-DD", code: "INVALID_DATE" }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const [event, managed] = await Promise.all([
        db.event.findFirst({ where: gate.eventWhere, select: { id: true, timezone: true } }),
        db.event.count({ where: eventWhereFor(gate.principal, "payments.refund", eventId) }),
      ]);
      if (!event) {
        apiLogger.warn({ msg: "desk-summary:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }

      const timezone = resolveTimezone(event.timezone);
      const date = requested ?? localDateInTz(new Date(), timezone);
      const { start, end } = deskDayBounds(date, timezone);
      const seesAll = managed > 0;
      const userId = session.user.id;

      const [walkIns, payments] = await Promise.all([
        db.registration.findMany({
          where: { eventId, createdSource: "ONSITE_DESK", createdAt: { gte: start, lt: end } },
          select: {
            id: true,
            paymentStatus: true,
            originalPrice: true,
            ticketType: { select: { name: true, price: true } },
            pricingTier: { select: { name: true, price: true } },
          },
        }),
        db.payment.findMany({
          where: {
            registration: { eventId },
            paymentMethodType: { in: [...DESK_PAYMENT_METHODS] },
            status: { in: ["PAID", "REFUNDED"] },
            createdAt: { gte: start, lt: end },
            ...(seesAll ? {} : { metadata: { path: ["recordedByUserId"], equals: userId } }),
          },
          select: { amount: true, currency: true, refundedAmount: true, paymentMethodType: true, metadata: true },
        }),
      ]);

      // Who registered each walk-in: its CREATE audit row (the registration has no creator column).
      const creators = walkIns.length
        ? await db.auditLog.findMany({
            where: { entityType: "Registration", action: "CREATE", entityId: { in: walkIns.map((w) => w.id) } },
            select: { entityId: true, userId: true },
          })
        : [];
      const creatorOf = new Map(creators.map((c) => [c.entityId, c.userId]));
      const visibleWalkIns = seesAll ? walkIns : walkIns.filter((w) => creatorOf.get(w.id) === userId);

      const paymentRows = payments.map((p) => ({
        method: p.paymentMethodType as DeskPaymentMethod,
        currency: p.currency,
        amount: Number(p.amount),
        refunded: Number(p.refundedAmount),
        recordedByUserId: readRecordedBy(p.metadata),
      }));
      const summary = summariseDeskDay(
        visibleWalkIns.map((w) => ({
          paymentStatus: w.paymentStatus,
          ticketTypeName: w.ticketType?.name ?? null,
          rateName: w.pricingTier?.name ?? null,
          // The price stamped at registration, as every money screen reads it, so
          // a rate repriced later does not turn yesterday's Free into Comp.
          ratePrice: readRegistrationBasePrice(w),
        })),
        paymentRows,
      );

      const userIds = [...new Set(summary.money.byUser.map((m) => m.userId).filter((id): id is string => !!id))];
      const users = userIds.length
        ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true, email: true } })
        : [];
      const names = Object.fromEntries(users.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email]));

      apiLogger.info({ msg: "desk-summary:read", eventId, date, scope: seesAll ? "all" : "own", walkIns: summary.walkIns.total, payments: paymentRows.length, userId });
      return NextResponse.json({ date, timezone, scope: seesAll ? "all" : "own", ...summary, userNames: names });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "desk-summary:failed", eventId });
    return NextResponse.json({ error: "Failed to read the desk summary" }, { status: 500 });
  }
}

function readRecordedBy(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const id = (metadata as { recordedByUserId?: unknown }).recordedByUserId;
  return typeof id === "string" ? id : null;
}
