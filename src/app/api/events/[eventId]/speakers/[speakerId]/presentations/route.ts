/**
 * A speaker's presentations, for staff (Nov 19, 2026;
 * docs/SPEAKER_PRESENTATIONS_PLAN.md).
 *
 *   GET  the speaker's talks and the files received for them
 *   POST allow an upload on the speaker's behalf: answers what the browser
 *        needs to send the file straight to storage
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { checkRateLimit } from "@/lib/security";
import { presentationRefusal, startPresentationUploadSchema, startUploadResponse } from "@/lib/speaker-presentation-http";
import { listSpeakerPresentations, startPresentationUpload } from "@/services/speaker-presentation-service";
import { loadStaffSpeaker } from "./_staff";

interface RouteParams {
  params: Promise<{ eventId: string; speakerId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [p, session] = await Promise.all([params, auth()]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const route = "events/[eventId]/speakers/[speakerId]/presentations:GET";
    const gate = requirePermission(session, "speakers.documents.read", { route, eventId: p.eventId });
    if (!gate.ok) return gate.response;
    const userId = session.user.id;

    return await runWithTenantLane(session.user.organizationId, { route: "speakers:presentations", userId }, async () => {
      const scope = await loadStaffSpeaker(gate, p.eventId, p.speakerId);
      if (!scope) {
        apiLogger.warn({ msg: "speaker-presentations:not-found", route, eventId: p.eventId, speakerId: p.speakerId, userId });
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }
      return NextResponse.json(await listSpeakerPresentations(scope));
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "speaker-presentations:get-failed" });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [p, session, body] = await Promise.all([params, auth(), req.json().catch(() => null)]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const route = "events/[eventId]/speakers/[speakerId]/presentations:POST";
    const gate = requirePermission(session, "speakers.documents.write", { route, eventId: p.eventId });
    if (!gate.ok) return gate.response;
    const userId = session.user.id;

    return await runWithTenantLane(session.user.organizationId, { route: "speakers:presentations", userId }, async () => {
      const scope = await loadStaffSpeaker(gate, p.eventId, p.speakerId);
      if (!scope) {
        apiLogger.warn({ msg: "speaker-presentations:not-found", route, eventId: p.eventId, speakerId: p.speakerId, userId });
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }
      const limit = checkRateLimit({ key: `speaker-presentation-start:${userId}`, limit: 120, windowMs: 3600_000 });
      if (!limit.allowed) {
        apiLogger.warn({ msg: "speaker-presentations:rate-limited", userId, eventId: scope.eventId });
        return NextResponse.json(
          { error: "Too many uploads. Try again later.", retryAfterSeconds: limit.retryAfterSeconds },
          { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 60) } },
        );
      }
      const parsed = startPresentationUploadSchema.safeParse(body);
      if (!parsed.success) {
        apiLogger.warn({ msg: "speaker-presentations:zod-validation-failed", errors: parsed.error.flatten(), eventId: scope.eventId });
        return NextResponse.json({ error: "Invalid input" }, { status: 400 });
      }
      const result = await startPresentationUpload({ ...scope, ...parsed.data, actor: { source: "staff", userId } });
      if (!result.ok) return presentationRefusal(result);
      return startUploadResponse(result, (id) => `/api/events/${scope.eventId}/speakers/${scope.speakerId}/presentations/${id}/file`);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "speaker-presentations:post-failed" });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
