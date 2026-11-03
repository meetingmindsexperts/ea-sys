import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { can } from "@/lib/permissions/can";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { claimSpareDtcmCode } from "@/lib/dtcm-pool";
import { isStalePending, issueDtcmTicket, type IssueDtcmTicketErrorCode } from "@/services/dtcm-eticket-service";
import { getDetCredentials } from "@/lib/dtcm-eticket/credentials";
import { isMappingCurrent, readDtcmEventSettings } from "@/lib/dtcm-eticket/sections";

/**
 * One registration's DTCM ticket from DET (docs/DTCM_ETICKET_PLAN.md §5.4).
 *
 * GET  — the registration's DET orders, newest first, so the sheet can show
 *        an uncertain or unread one.
 * POST — buy one now (the desk). If DET definitely did not sell it, or cannot
 *        be reached, fall back to a spare code from the pool so the attendee
 *        still leaves with one. NEVER on UNCERTAIN: a ticket may exist, and
 *        the person resolving it decides.
 *
 * The two gates of the pool route, for the same reasons: `dtcm.assign` (desk
 * staff on their events) AND `barcode.view` (this hands over a door
 * credential, which MEMBER may not hold). Organisation members only: the DET
 * account is the organisation's.
 */
interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

const HTTP_STATUS: Record<IssueDtcmTicketErrorCode, number> = {
  REGISTRATION_NOT_FOUND: 404,
  NOT_CONFIGURED: 400,
  DTCM_OFF: 400,
  CANCELLED: 400,
  WAITLISTED: 400,
  VIRTUAL: 400,
  ALREADY_HAS_CODE: 409,
  TYPE_NOT_MAPPED: 400,
  MAPPING_STALE: 400,
  MISSING_NAME: 400,
  MISSING_EMAIL: 400,
  MISSING_PHONE: 400,
  MISSING_COUNTRY: 400,
  ALREADY_IN_PROGRESS: 409,
  PERFORMANCE_UNAVAILABLE: 502,
  NOT_ON_DET_MAP: 400,
  DET_REFUSED: 502,
  UNCERTAIN: 409,
  PURCHASED_NO_BARCODE: 202,
  CODE_ARRIVED_MEANWHILE: 409,
};

/** DET could not or would not sell, and nothing was bought: the pool may step in. */
const FALL_BACK_TO_POOL: ReadonlySet<IssueDtcmTicketErrorCode> = new Set(["DET_REFUSED", "PERFORMANCE_UNAVAILABLE"]);

type Gate =
  | { response: NextResponse }
  | {
      userId: string;
      eventId: string;
      registrationId: string;
      organizationId: string;
      eventWhere: Prisma.EventWhereInput;
    };

async function gate(routeParams: RouteParams, method: "GET" | "POST"): Promise<Gate> {
  const [{ eventId, registrationId }, session] = await Promise.all([routeParams.params, auth()]);
  if (!session?.user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const userId = session.user.id;
  const route = `events/[eventId]/registrations/[registrationId]/dtcm-eticket:${method}`;
  if (!session.user.organizationId) {
    apiLogger.warn({ msg: "dtcm-eticket:desk-no-org", eventId, userId, method });
    return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const access = requirePermission(session, "dtcm.assign", { route, eventId });
  if (!access.ok) return { response: access.response };
  if (!can(access.principal, "barcode.view")) {
    apiLogger.warn({ msg: "dtcm-eticket:desk-barcode-role-refused", eventId, userId, role: session.user.role });
    return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { userId, eventId, registrationId, organizationId: session.user.organizationId, eventWhere: access.eventWhere };
}

export async function GET(_req: Request, routeParams: RouteParams) {
  try {
    const g = await gate(routeParams, "GET");
    if ("response" in g) return g.response;
    return await runWithTenantLane(g.organizationId, { route: "events:registration-dtcm-eticket:GET", userId: g.userId }, async () => {
      const event = await db.event.findFirst({
        where: g.eventWhere,
        select: { id: true, requiresDtcmBarcode: true, dtcmPerformanceCode: true, settings: true },
      });
      if (!event) {
        apiLogger.warn({ msg: "dtcm-eticket:desk-event-not-found", eventId: g.eventId, userId: g.userId });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const [registration, creds] = await Promise.all([
        db.registration.findFirst({ where: { id: g.registrationId, eventId: g.eventId }, select: { ticketTypeId: true } }),
        getDetCredentials(g.organizationId),
      ]);
      // Whether the "Get code from DET" button can work for this person: no DB
      // write, no DET call. The purchase re-checks everything.
      const stored = readDtcmEventSettings(event.settings);
      const detReady = Boolean(
        event.requiresDtcmBarcode &&
          creds &&
          registration?.ticketTypeId &&
          stored.sections?.[registration.ticketTypeId] &&
          isMappingCurrent(stored, creds.environment, event.dtcmPerformanceCode),
      );
      const orders = await db.dtcmOrder.findMany({
        where: { eventId: g.eventId, registrationId: g.registrationId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          status: true,
          environment: true,
          orderId: true,
          barcode: true,
          area: true,
          priceTypeCode: true,
          errorMessage: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      // A crashed PENDING is unresolved too; the client cannot know "stale".
      return NextResponse.json({
        detReady,
        environment: creds?.environment ?? null,
        orders: orders.map((o) => ({ ...o, unresolved: o.status === "UNCERTAIN" || isStalePending(o) })),
      });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "dtcm-eticket:desk-get-failed" });
    return NextResponse.json({ error: "Failed to read DET orders" }, { status: 500 });
  }
}

export async function POST(_req: Request, routeParams: RouteParams) {
  try {
    const g = await gate(routeParams, "POST");
    if ("response" in g) return g.response;
    const { userId, eventId, registrationId, organizationId } = g;

    // Each call can buy a real ticket: generous for a busy desk, bounded so a
    // stuck client cannot spend the permit.
    const limit = checkRateLimit({ key: `dtcm-eticket-desk:${userId}`, limit: 120, windowMs: 3600_000 });
    if (!limit.allowed) return rateLimited(limit, { route: "events/registrations/dtcm-eticket", userId });

    return await runWithTenantLane(organizationId, { route: "events:registration-dtcm-eticket:POST", userId }, async () => {
      const event = await db.event.findFirst({ where: g.eventWhere, select: { id: true, requiresDtcmBarcode: true } });
      if (!event) {
        apiLogger.warn({ msg: "dtcm-eticket:desk-event-not-found", eventId, userId });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }

      const result = await issueDtcmTicket({ organizationId, eventId, registrationId, userId, source: "rest" });
      if (result.ok) {
        return NextResponse.json({ source: "det", barcode: result.barcode, order: { id: result.order.id, orderId: result.order.orderId } });
      }

      if (FALL_BACK_TO_POOL.has(result.code)) {
        const spare = await claimSpareDtcmCode({ eventId, registrationId, requiresDtcm: event.requiresDtcmBarcode });
        if (spare.status === "assigned") {
          apiLogger.warn({ msg: "dtcm-eticket:desk-fell-back-to-pool", eventId, registrationId, detCode: result.code, userId });
          return NextResponse.json({ source: "pool", barcode: spare.code, detError: result.message });
        }
        apiLogger.warn({ msg: "dtcm-eticket:desk-pool-fallback-empty", eventId, registrationId, pool: spare.status });
      }

      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.order && { order: { id: result.order.id, status: result.order.status } }) },
        { status: HTTP_STATUS[result.code] },
      );
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "dtcm-eticket:desk-post-failed" });
    return NextResponse.json({ error: "Failed to get a DTCM code from DET" }, { status: 500 });
  }
}
