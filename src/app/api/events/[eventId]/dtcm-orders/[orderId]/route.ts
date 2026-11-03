import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { can } from "@/lib/permissions/can";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { resolveDtcmOrder, type ResolveDtcmOrderErrorCode } from "@/services/dtcm-eticket-service";

/**
 * Resolving a DET order a person has to look at (docs/DTCM_ETICKET_PLAN.md §5.2):
 *   found        — an UNCERTAIN (or crashed PENDING) order: the person found the
 *                  sale in DET and enters its order number, which is checked
 *                  with DET before it is trusted.
 *   not-bought   — DET has no such sale; the attempt ends and a new one may start.
 *   read-barcode — a PURCHASED order whose barcode could not be read yet.
 *
 * `dtcm.import` (ADMIN and ORGANIZER), not a desk key: deciding that a sale
 * did not happen is a judgement about the permit, not a counter task. Plus
 * `barcode.view`, because the answer can carry the code.
 */
interface RouteParams {
  params: Promise<{ eventId: string; orderId: string }>;
}

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("found"), detOrderId: z.string().trim().min(1).max(50).regex(/^[A-Za-z0-9-]+$/) }),
  z.object({ action: z.literal("not-bought") }),
  z.object({ action: z.literal("read-barcode") }),
]);

const HTTP_STATUS: Partial<Record<ResolveDtcmOrderErrorCode, number>> = {
  ORDER_NOT_FOUND: 404,
  WRONG_STATUS: 409,
  NOT_CONFIGURED: 400,
  DET_ORDER_NOT_FOUND: 400,
  DET_FAILED: 502,
  PURCHASED_NO_BARCODE: 202,
  CODE_ARRIVED_MEANWHILE: 409,
};

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, orderId }, session, body] = await Promise.all([params, auth(), req.json().catch(() => null)]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "dtcm-eticket:resolve-no-org", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const access = requirePermission(session, "dtcm.import", { route: "events/[eventId]/dtcm-orders/[orderId]:PATCH", eventId });
    if (!access.ok) return access.response;
    if (!can(access.principal, "barcode.view")) {
      apiLogger.warn({ msg: "dtcm-eticket:resolve-barcode-role-refused", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const limit = checkRateLimit({ key: `dtcm-eticket-resolve:${session.user.id}`, limit: 60, windowMs: 3600_000 });
    if (!limit.allowed) return rateLimited(limit, { route: "events/dtcm-orders", userId: session.user.id });

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "dtcm-eticket:resolve-validation-failed", eventId, orderId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const organizationId = session.user.organizationId;

    return await runWithTenantLane(organizationId, { route: "events:dtcm-orders:PATCH", userId: session.user.id }, async () => {
      const event = await db.event.findFirst({ where: access.eventWhere, select: { id: true } });
      if (!event) {
        apiLogger.warn({ msg: "dtcm-eticket:resolve-event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const action =
        parsed.data.action === "found" ? { kind: "found" as const, detOrderId: parsed.data.detOrderId } : { kind: parsed.data.action };
      const result = await resolveDtcmOrder({ organizationId, eventId, dtcmOrderId: orderId, userId: session.user.id, action });
      if (result.ok) {
        return NextResponse.json({ order: { id: result.order.id, status: result.order.status, orderId: result.order.orderId }, barcode: result.barcode });
      }
      return NextResponse.json({ error: result.message, code: result.code }, { status: HTTP_STATUS[result.code] ?? 400 });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "dtcm-eticket:resolve-failed" });
    return NextResponse.json({ error: "Failed to resolve the DET order" }, { status: 500 });
  }
}
