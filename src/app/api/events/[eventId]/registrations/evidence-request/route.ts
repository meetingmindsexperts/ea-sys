import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { linkExpiryDaysSchema } from "@/lib/link-expiry";
import { sendEvidenceRequests } from "@/services/evidence-request-service";

/**
 * Request ID and document: each person's own link to add what their
 * registration type requires and their registration does not hold yet
 * (src/lib/evidence-request.ts, Nov 4, 2026). The rules live in
 * evidence-request-service; this route is auth, the limit and HTTP.
 */
const bodySchema = z.object({
  registrationIds: z.array(z.string().min(1)).min(1).max(500),
  expiryDays: linkExpiryDaysSchema("Request link"),
});

const ROUTE = "events/[eventId]/registrations/evidence-request:POST";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "communications.send", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
      const rateLimit = checkRateLimit({
        key: `evidence-request:org:${orgGuard.orgId}`,
        limit: 10,
        windowMs: 60 * 60 * 1000,
      });
      if (!rateLimit.allowed) {
        apiLogger.warn({ msg: "evidence-request:rate-limited", eventId, retryAfterSeconds: rateLimit.retryAfterSeconds });
        return NextResponse.json(
          { error: "Rate limit reached. Maximum 10 sends per hour.", retryAfterSeconds: rateLimit.retryAfterSeconds },
          { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
        );
      }

      const validated = bodySchema.safeParse(await req.json().catch(() => null));
      if (!validated.success) {
        apiLogger.warn({ msg: "evidence-request:validation-failed", eventId, errors: validated.error.flatten() });
        return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
      }

      // The grant's own event scope: an event outside it is a 404 here, before
      // the service, which scopes by organisation only.
      const [event, signer] = await Promise.all([
        db.event.findFirst({ where: gate.eventWhere, select: { id: true } }),
        db.user.findUnique({ where: { id: session.user.id }, select: { emailSignature: true } }),
      ]);
      if (!event) {
        apiLogger.warn({ msg: "evidence-request:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }

      const result = await sendEvidenceRequests({
        eventId,
        organizationId: orgGuard.orgId,
        registrationIds: validated.data.registrationIds,
        expiryDays: validated.data.expiryDays,
        appUrl: process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000",
        actorUserId: session.user.id,
        organizerName: [session.user.firstName, session.user.lastName].filter(Boolean).join(" "),
        organizerSignature: signer?.emailSignature ?? "",
      });
      if (!result.ok) {
        apiLogger.warn({ msg: "evidence-request:refused", eventId, code: result.code });
        return NextResponse.json(
          { error: result.message, code: result.code },
          { status: result.code === "EVENT_NOT_FOUND" ? 404 : 500 },
        );
      }
      return NextResponse.json({
        sent: result.sent,
        skipped: result.skipped.length,
        skippedDetails: result.skipped,
        errors: result.errors,
      });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "evidence-request:unhandled" });
    return NextResponse.json({ error: "Could not send the requests. Please try again." }, { status: 500 });
  }
}
