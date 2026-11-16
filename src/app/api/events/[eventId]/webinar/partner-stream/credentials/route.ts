import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { apiLogger } from "@/lib/logger";
import { can } from "@/lib/permissions/can";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { revealExternalStreamCredentials } from "@/services/external-stream-service";
import { findPartnerWebinar, partnerStreamRefusal } from "../shared";

type RouteParams = { params: Promise<{ eventId: string }> };

/**
 * Show the partner's server address and stream key (Nov 16, 2026; external
 * streams step 5). A POST, not a GET: every look is written to the audit log,
 * and a GET could be prefetched or cached. Only for someone who runs the
 * webinar AND holds "See Zoom host details", the permission that already
 * guards stream keys. Never cached.
 */
export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const route = "events/[eventId]/webinar/partner-stream/credentials:POST";
    const orgGuard = requireOrgId(session, { route });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route, eventId });
    if (!gate.ok) return gate.response;
    if (!can(gate.principal, "zoomHost.view")) {
      apiLogger.warn({ eventId, userId: session.user.id }, "webinar-partner-stream:key-refused-no-host-permission");
      return NextResponse.json(
        { error: "Showing the partner's stream key needs \"See Zoom host details\".", code: "FORBIDDEN" },
        { status: 403 },
      );
    }

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-partner-stream-key:${session.user.id}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "webinar-partner-stream:key-rate-limited");
      return NextResponse.json(
        { error: "Too many requests", retryAfterSeconds, limit: 60, windowSeconds: 3600 },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const found = await findPartnerWebinar(gate.eventWhere, { eventId, userId: session.user.id, route });
      if (!found.ok) return found.response;
      const result = await revealExternalStreamCredentials({
        organizationId: orgGuard.orgId,
        eventId,
        sessionId: found.sessionId,
        userId: session.user.id,
        source: "rest",
      });
      if (!result.ok) return partnerStreamRefusal(result);
      return NextResponse.json({ credentials: result.credentials }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-partner-stream:key-failed");
    return NextResponse.json({ error: "Failed to show the partner stream key" }, { status: 500 });
  }
}
