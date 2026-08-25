import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, REGISTRATION_DESK_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { canViewEntryBarcode } from "@/lib/barcode-visibility";
import { getDtcmPoolCounts, claimSpareDtcmCode } from "@/lib/dtcm-pool";

/**
 * The DTCM spare-code pool, for the desk.
 *
 * GET  — how many codes were imported, how many are spare.
 * POST — hand the next spare to a named registration.
 *
 * TWO GATES, ANSWERING TWO DIFFERENT QUESTIONS. Neither is sufficient alone.
 *
 *   1. `denyReviewer(..., { allow: REGISTRATION_DESK_ALLOW })` — may this role
 *      write on a desk route at all? This is the walk-up path: someone
 *      registers at the counter on the morning and needs a compliance code
 *      before their badge prints, so ONSITE temps have to reach it. Paired with
 *      `buildEventAccessWhere` as that allow-list REQUIRES, so an ONSITE temp
 *      assigned to event A cannot drain event B's pool.
 *
 *   2. `canViewEntryBarcode` — may this role HOLD a door credential? A DTCM
 *      code is in `BARCODE_KEYS`, and this route returns the raw value.
 *
 * The first gate was originally the only one, and that was a credential leak.
 * `REGISTRATION_DESK_ALLOW` includes MEMBER; `BARCODE_ROLES` deliberately
 * EXCLUDES it, because a read-only internal viewer has no reason to hold
 * something that opens a door (the July 11 2026 H6/H7/H8 decision). The
 * `already-has-code` outcome is a pure READ of the code on someone else's row
 * with no write at all — and because MEMBER's registration payloads are
 * redacted, every row renders as "Not set", so the button was offered on all of
 * them. Redaction made it worse rather than better: it turned the leak into one
 * click per registration, across every event in the org.
 *
 * The lesson, and it is the one AGENTS.md already states: reaching for a
 * close-enough existing predicate is the signal to check who else is in it.
 * `REGISTRATION_DESK_ALLOW` is the right answer to "who staffs the desk" and
 * the wrong answer to "who may see a credential".
 */
interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session, {
      allow: REGISTRATION_DESK_ALLOW,
      route: "events/[eventId]/dtcm-pool:GET",
    });
    if (denied) return denied;

    if (!canViewEntryBarcode(session.user.role)) {
      apiLogger.warn(
        { msg: "dtcm-pool:barcode-role-refused", eventId, userId: session.user.id, role: session.user.role },
        "Role may staff the desk but may not hold a door credential",
      );
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return await runWithTenantLane(
      session.user.organizationId,
      { route: "events:dtcm-pool:GET", userId: session.user.id },
      async () => {
        const event = await db.event.findFirst({
          where: buildEventAccessWhere(session.user, eventId, { surface: "desk" }),
          select: { id: true, requiresDtcmBarcode: true },
        });
        if (!event) {
          apiLogger.warn(
            { msg: "dtcm-pool:event-not-found", eventId, userId: session.user.id, role: session.user.role },
            "Event not found or not accessible",
          );
          return NextResponse.json({ error: "Event not found" }, { status: 404 });
        }

        // Not an error: the card simply does not render on a non-Dubai event.
        if (!event.requiresDtcmBarcode) {
          return NextResponse.json({ enabled: false, counts: null });
        }

        return NextResponse.json({ enabled: true, counts: await getDtcmPoolCounts(eventId) });
      },
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "dtcm-pool:get-failed" }, "Failed to read the DTCM pool");
    return NextResponse.json({ error: "Failed to read the code pool" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session, {
      allow: REGISTRATION_DESK_ALLOW,
      route: "events/[eventId]/dtcm-pool:POST",
    });
    if (denied) return denied;

    // Before the rate limit, so a refused role never spends another caller's
    // budget — the same ordering the registrations export uses.
    if (!canViewEntryBarcode(session.user.role)) {
      apiLogger.warn(
        { msg: "dtcm-pool:barcode-role-refused", eventId, userId: session.user.id, role: session.user.role },
        "Role may staff the desk but may not assign a door credential",
      );
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Each claim is two reads and a guarded write. Generous enough for a busy
    // morning at the counter, bounded enough that a stuck client cannot drain
    // the block by spinning.
    const limit = checkRateLimit({
      key: `dtcm-claim:${session.user.id}`,
      limit: 300,
      windowMs: 60 * 60 * 1000,
    });
    if (!limit.allowed) {
      return rateLimited(limit, { route: "events/dtcm-pool", userId: session.user.id });
    }

    const body = await req.json().catch(() => null);
    const registrationId = typeof body?.registrationId === "string" ? body.registrationId : null;
    if (!registrationId) {
      apiLogger.warn(
        { msg: "dtcm-pool:missing-registration-id", eventId, userId: session.user.id },
        "Claim called without a registrationId",
      );
      return NextResponse.json(
        { error: "registrationId is required", code: "MISSING_REGISTRATION_ID" },
        { status: 400 },
      );
    }

    return await runWithTenantLane(
      session.user.organizationId,
      { route: "events:dtcm-pool:POST", userId: session.user.id },
      async () => {
        const event = await db.event.findFirst({
          where: buildEventAccessWhere(session.user, eventId, { surface: "desk" }),
          select: { id: true, requiresDtcmBarcode: true },
        });
        if (!event) {
          apiLogger.warn(
            { msg: "dtcm-pool:event-not-found", eventId, userId: session.user.id, role: session.user.role },
            "Event not found or not accessible",
          );
          return NextResponse.json({ error: "Event not found" }, { status: 404 });
        }

        const outcome = await claimSpareDtcmCode({
          eventId,
          registrationId,
          requiresDtcm: !!event.requiresDtcmBarcode,
        });

        // Every non-success path logs, so "why did the desk not get a code?" is
        // answerable from /logs rather than from the operator's memory.
        if (outcome.status !== "assigned") {
          apiLogger.warn(
            {
              msg: "dtcm-pool:claim-not-assigned",
              eventId,
              registrationId,
              outcome: outcome.status,
              userId: session.user.id,
            },
            "Manual DTCM claim did not assign a code",
          );
        }

        const HTTP: Record<string, number> = {
          assigned: 200,
          "already-has-code": 200,
          "pool-empty": 409,
          "not-applicable": 400,
          failed: 500,
        };
        const MESSAGE: Record<string, string> = {
          "pool-empty":
            "No spare DTCM codes left for this event. Import more from the block DTCM issued, then try again.",
          "not-applicable":
            "This event does not use DTCM codes, or this is a virtual attendee who gets no badge.",
          failed: "Could not assign a code — see the server logs.",
        };

        return NextResponse.json(
          outcome.status === "assigned" || outcome.status === "already-has-code"
            ? { status: outcome.status, code: outcome.code }
            : { status: outcome.status, error: MESSAGE[outcome.status], code: outcome.status },
          { status: HTTP[outcome.status] ?? 500 },
        );
      },
    );
  } catch (error) {
    apiLogger.error(
      { err: error, msg: "dtcm-pool:claim-failed", ip: getClientIp(req) },
      "Failed to claim a DTCM code",
    );
    return NextResponse.json({ error: "Failed to assign a code" }, { status: 500 });
  }
}
