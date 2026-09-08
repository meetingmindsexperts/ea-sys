/**
 * PATCH /api/events/[eventId]/travel-grants/[grantId] — the organizer sets a
 * grant's status from the console (Sep 8, 2026).
 *
 *   { status: "PENDING" }   reopen: the author's link works again and the
 *                           email block re-asks on their next abstract
 *   { status: "CONSENTED" } record an application on the author's behalf
 *   { status: "DECLINED" }  record a decline on the author's behalf
 *
 * Modelled on the speaker-agreement PATCH (accept / revoke by organizer). The
 * row records WHO set it in `decidedBy` (`ORGANIZER:<userId>`, cleared again
 * when the author answers through the public form), the audit row carries
 * before → after + IP, and an organizer-set CONSENTED carries no signed name:
 * the console labels it "set by organiser" rather than pretending the author
 * signed. The public form stays locked after the author's own answer; this
 * route is the only way to reopen it.
 *
 * ACCESS: the travel-grant boundary, `denyReviewer(session)` with no
 * allow-list (SUPER_ADMIN / ADMIN / ORGANIZER), event through
 * buildEventAccessWhere, the write bound to { id, eventId }.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rateLimited, zodErrorResponse } from "@/lib/api-errors";
import { DEFAULT_TRAVEL_GRANT_TERMS_HTML } from "@/lib/travel-grant/constants";

type RouteParams = { params: Promise<{ eventId: string; grantId: string }> };

const patchSchema = z.object({
  status: z.enum(["PENDING", "CONSENTED", "DECLINED"]),
});

export async function PATCH(req: Request, { params }: RouteParams) {
  const route = "events/[eventId]/travel-grants/[grantId]:PATCH";
  try {
    const [session, { eventId, grantId }, body] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    if (!session?.user) {
      apiLogger.warn({ eventId, grantId }, "travel-grant-status:unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session, { route: "events/[eventId]/travel-grants/[grantId]:PATCH" });
    if (denied) {
      apiLogger.warn({ eventId, grantId, role: session.user.role }, "travel-grant-status:role-refused");
      return denied;
    }

    const rl = checkRateLimit({ key: `travel-grant-status:${session.user.id}`, limit: 60, windowMs: 3600_000 });
    if (!rl.allowed) {
      return rateLimited(rl, { route, eventId, userId: session.user.id, limit: 60, windowSeconds: 3600 });
    }

    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route, eventId, grantId, userId: session.user.id });
    }
    const next = parsed.data.status;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true, travelGrantTermsHtml: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, grantId, userId: session.user.id }, "travel-grant-status:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const ip = getClientIp(req);
    return await runWithTenant(event.organizationId, async () => {
      const before = await db.travelGrant.findFirst({
        where: { id: grantId, eventId },
        select: {
          id: true,
          status: true,
          signedName: true,
          decidedBy: true,
          speaker: { select: { id: true, firstName: true, lastName: true, organization: true, country: true } },
        },
      });
      if (!before) {
        apiLogger.warn({ eventId, grantId, userId: session.user.id }, "travel-grant-status:grant-not-found");
        return NextResponse.json({ error: "Travel grant not found" }, { status: 404 });
      }
      if (before.status === next) {
        return NextResponse.json({ ok: true, changed: false, status: next, decidedBy: before.decidedBy });
      }

      const decidedBy = `ORGANIZER:${session.user.id}`;
      const now = new Date();
      const data =
        next === "PENDING"
          ? {
              // Reopen: the author's own answer is withdrawn so the form accepts a new one.
              status: "PENDING" as const,
              signedName: null,
              submittedAt: null,
              submittedIp: null,
              countryAtConsent: null,
              fullName: null,
              institution: null,
              termsSnapshot: null,
              decidedBy,
            }
          : next === "CONSENTED"
            ? {
                status: "CONSENTED" as const,
                // No e-signature: the organizer answered for them, and the row says so.
                signedName: null,
                submittedAt: now,
                submittedIp: ip,
                countryAtConsent: before.speaker.country ?? null,
                fullName: [before.speaker.firstName, before.speaker.lastName].filter(Boolean).join(" "),
                institution: before.speaker.organization ?? null,
                termsSnapshot: event.travelGrantTermsHtml?.trim() || DEFAULT_TRAVEL_GRANT_TERMS_HTML,
                decidedBy,
              }
            : {
                status: "DECLINED" as const,
                signedName: null,
                submittedAt: now,
                submittedIp: ip,
                countryAtConsent: null,
                fullName: null,
                institution: null,
                termsSnapshot: null,
                decidedBy,
              };

      // Bound to { id, eventId } on the write itself (defence #1).
      const { count } = await db.travelGrant.updateMany({ where: { id: grantId, eventId }, data });
      if (count === 0) {
        apiLogger.warn({ eventId, grantId, userId: session.user.id }, "travel-grant-status:write-missed");
        return NextResponse.json({ error: "Travel grant not found" }, { status: 404 });
      }

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "TRAVEL_GRANT_STATUS_SET",
            entityType: "TravelGrant",
            entityId: grantId,
            ipAddress: ip,
            changes: {
              actor: "ORGANIZER",
              speakerId: before.speaker.id,
              before: { status: before.status, signedName: before.signedName, decidedBy: before.decidedBy },
              after: { status: next, decidedBy },
              ip,
            },
          },
        })
        .catch((err) => apiLogger.error({ err, eventId, grantId }, "travel-grant-status:audit-failed"));

      apiLogger.info(
        { eventId, grantId, speakerId: before.speaker.id, userId: session.user.id, before: before.status, after: next },
        "travel-grant-status:set",
      );
      return NextResponse.json({ ok: true, changed: true, status: next, decidedBy });
    });
  } catch (err) {
    apiLogger.error({ err }, "travel-grant-status:patch-failed");
    return NextResponse.json({ error: "Failed to update the travel grant" }, { status: 500 });
  }
}
