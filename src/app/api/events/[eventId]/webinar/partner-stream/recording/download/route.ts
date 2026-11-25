import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { streamRecordingDownload, type StreamRecordingErrorCode } from "@/services/stream-recording-service";
import { findPartnerWebinar } from "../../shared";

type RouteParams = { params: Promise<{ eventId: string }> };

/**
 * Download the MP4 of a partner stream's recording (Nov 25, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md §4.4, step 4): answers a 5 minute
 * signed link to the file in storage, never the file itself (a webinar is
 * gigabytes). A POST on purpose: every download is audited, so it is asked
 * for by a press, never prefetched or cached. `webinar.manage` (D7).
 */

const STATUS: Partial<Record<StreamRecordingErrorCode, number>> = { NOT_STARTED: 404, NO_FILE: 404 };

export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const route = "events/[eventId]/webinar/partner-stream/recording/download:POST";
    const orgGuard = requireOrgId(session, { route });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route, eventId });
    if (!gate.ok) return gate.response;

    const { allowed, retryAfterSeconds } = checkRateLimit({ key: `webinar-stream-recording-download:${session.user.id}`, limit: 30, windowMs: 3600_000 });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "webinar-stream-recording:download-rate-limited");
      return NextResponse.json(
        { error: "Too many requests", retryAfterSeconds, limit: 30, windowSeconds: 3600 },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const found = await findPartnerWebinar(gate, { eventId, userId: session.user.id, route });
      if (!found.ok) return found.response;
      const result = await streamRecordingDownload({
        organizationId: orgGuard.orgId,
        eventId,
        sessionId: found.sessionId,
        userId: session.user.id,
        source: "rest",
        eventSlug: found.slug,
      });
      // The service has already logged a refusal.
      if (!result.ok) return NextResponse.json({ error: result.message, code: result.code }, { status: STATUS[result.code] ?? 409 });
      if (!result.url) {
        // The local provider has no bucket to sign for: development only.
        apiLogger.warn({ eventId }, "webinar-stream-recording:download-no-signed-link");
        return NextResponse.json({ error: "Downloading needs the server's file storage (S3)." }, { status: 501 });
      }
      return NextResponse.json({ url: result.url, fileName: result.fileName });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-stream-recording:download-failed");
    return NextResponse.json({ error: "Failed to prepare the download" }, { status: 500 });
  }
}
