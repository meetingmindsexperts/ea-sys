import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rateLimited, zodErrorResponse } from "@/lib/api-errors";
import { runWithTenant } from "@/lib/tenant-context";
import { renderQrPng } from "@/lib/barcode";
import { RESTAMPABLE_STATUSES } from "@/lib/registration-form-pricing";
import { mintOnsiteCompletionLink } from "@/services/registration-form-service";

/**
 * POST /api/events/[eventId]/registrations/[registrationId]/onsite-link
 *
 * Complete onsite (docs/ONSITE_DESK_PLAN.md §5.4): a 30-minute, single-use,
 * details-only completion link for someone the organiser added or imported,
 * returned with a QR code for the attendee's phone, or opened on the desk
 * tablet. Minting revokes their emailed link. This is the only place the raw
 * link is shown to staff, so it writes an audit row (never the token).
 */

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

const ROUTE = "events/[eventId]/registrations/[registrationId]/onsite-link:POST";
const LINK_MINUTES = 30;
const bodySchema = z.object({ replace: z.boolean().optional() });

export async function POST(req: Request, { params }: RouteParams) {
  const { eventId, registrationId } = await params;
  try {
    const session = await auth();
    if (!session?.user) {
      apiLogger.warn({ msg: "onsite-link:unauthenticated", eventId, registrationId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE, eventId });
    if ("error" in orgGuard) return orgGuard.error;

    // The desk's key: whoever may admit the person may let them finish their form.
    const gate = requirePermission(session, "registrations.checkin", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    const rateLimit = checkRateLimit({ key: `onsite-link:${session.user.id}`, limit: 240, windowMs: 60 * 60 * 1000 });
    if (!rateLimit.allowed) {
      return rateLimited(rateLimit, { route: ROUTE, userId: session.user.id, eventId, limit: 240, windowSeconds: 3600 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true, slug: true } });
      if (!event) {
        apiLogger.warn({ msg: "onsite-link:event-not-found", eventId, registrationId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }

      const registration = await db.registration.findFirst({
        where: { id: registrationId, eventId },
        select: {
          id: true, status: true, userId: true, completedAt: true, ticketTypeId: true,
          paymentStatus: true, refundedAmount: true, promoCodeId: true, groupId: true, sponsorId: true,
          _count: { select: { payments: true, invoices: { where: { status: { not: "CANCELLED" } } } } },
        },
      });
      if (!registration) {
        apiLogger.warn({ msg: "onsite-link:registration-not-found", eventId, registrationId, userId: session.user.id });
        return NextResponse.json({ error: "Registration not found" }, { status: 404 });
      }
      if (registration.status === "CANCELLED") {
        apiLogger.warn({ msg: "onsite-link:cancelled", eventId, registrationId, userId: session.user.id });
        return NextResponse.json({ error: "This registration is cancelled.", code: "CANCELLED" }, { status: 409 });
      }
      // An account counts as completed, as everywhere else (registration-completion.ts).
      if (registration.completedAt || registration.userId) {
        apiLogger.warn({ msg: "onsite-link:already-completed", eventId, registrationId, userId: session.user.id });
        return NextResponse.json({ error: "Their details are already complete.", code: "ALREADY_COMPLETED" }, { status: 409 });
      }

      // With no type, the form lets them pick one and stamps its price. That is
      // safe only while nothing about the money is settled: a payment, an
      // invoice, a refund, a promo code or a group would leave the row priced
      // at whatever they chose (review of cf9775fd, HIGH 1). The organiser sets
      // the type first; with a type, the details-only link keeps it.
      if (!registration.ticketTypeId && holdsMoney(registration)) {
        apiLogger.warn({ msg: "onsite-link:type-required", eventId, registrationId, paymentStatus: registration.paymentStatus, userId: session.user.id });
        return NextResponse.json(
          { error: "Set their registration type first: money is already recorded against this registration.", code: "TYPE_REQUIRED" },
          { status: 409 },
        );
      }

      // `replace: true` only after staff confirmed: a live link is someone typing.
      // An empty body is the first try.
      const raw = await req.json().catch(() => ({}));
      const parsed = bodySchema.safeParse(raw ?? {});
      if (!parsed.success) {
        return zodErrorResponse(parsed, { route: "onsite-link:POST", eventId, userId: session.user.id });
      }
      const minted = await mintOnsiteCompletionLink({
        registrationId,
        eventSlug: event.slug,
        minutes: LINK_MINUTES,
        appUrl: process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000",
        replace: parsed.data.replace === true,
      });
      if (!minted.ok) {
        // A normal desk state, not a failure: the desk asks before replacing.
        // No link in the answer; only the desk that made it holds that.
        apiLogger.info({ msg: "onsite-link:link-active", eventId, registrationId, userId: session.user.id });
        return NextResponse.json({ code: "LINK_ACTIVE", expiresAt: minted.expires.toISOString() });
      }
      const { url, expires } = minted;
      const qr = await renderQrPng(url, { scale: 6 });

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "ONSITE_COMPLETION_LINK",
            entityType: "Registration",
            entityId: registrationId,
            changes: { expiresAt: expires.toISOString(), minutes: LINK_MINUTES, ip: getClientIp(req) },
          },
        })
        .catch((err) => apiLogger.warn({ err, msg: "onsite-link:audit-write-failed", registrationId }));

      apiLogger.info({ msg: "onsite-link:minted", eventId, registrationId, userId: session.user.id });
      return NextResponse.json({
        url,
        qr: `data:image/png;base64,${qr.toString("base64")}`,
        expiresAt: expires.toISOString(),
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "onsite-link:failed", eventId, registrationId });
    return NextResponse.json({ error: "Failed to create the link" }, { status: 500 });
  }
}

/** Money, a promo or a group already attached: the same checks the emailed form makes before re-pricing. */
function holdsMoney(reg: {
  paymentStatus: Parameters<typeof RESTAMPABLE_STATUSES.includes>[0];
  refundedAmount: unknown;
  promoCodeId: string | null;
  groupId: string | null;
  sponsorId: string | null;
  _count: { payments: number; invoices: number };
}): boolean {
  return (
    !RESTAMPABLE_STATUSES.includes(reg.paymentStatus) ||
    // Sponsor-paid: the sponsor would be billed at whatever type they pick
    // (review of 055680a9, MED 3). INCLUSIVE is re-priceable for an emailed
    // rate, but this link has no rate to price it at.
    reg.paymentStatus === "INCLUSIVE" ||
    !!reg.sponsorId ||
    Number(reg.refundedAmount) > 0 ||
    reg._count.payments > 0 ||
    reg._count.invoices > 0 ||
    !!reg.promoCodeId ||
    !!reg.groupId
  );
}
