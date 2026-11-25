import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import {
  deleteStreamRecording,
  finishStreamRecording,
  getStreamRecording,
  startStreamRecording,
  stopStreamRecording,
  streamRecordingAvailable,
  type ServerOutcome,
  type StreamRecordingErrorCode,
  type StreamRecordingResult,
} from "@/services/stream-recording-service";
import { findPartnerWebinar } from "../shared";

type RouteParams = { params: Promise<{ eventId: string }> };

/**
 * Recording a partner's stream, from the console (Nov 25, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md step 3, §4.5). Reads the recording,
 * starts, stops or finishes it, and deletes it (step 4; the download is
 * ./download); the rules and the stream server calls are all
 * in src/services/stream-recording-service.ts. `webinar.manage`, the key the
 * Partner stream card asks (D7). Never returns the stream key or where the
 * files are.
 */

const STATUS: Record<StreamRecordingErrorCode, number> = {
  // The server is not set up for it: nothing the person pressing the button can fix.
  NOT_AVAILABLE: 503,
  DISK_LOW: 503,
  NOT_PARTNER_STREAM: 409,
  AGREEMENT_REQUIRED: 400,
  NOT_STARTED: 404,
  ALREADY_FINISHED: 409,
  STILL_RECORDING: 409,
  STILL_PREPARING: 409,
  NO_FILE: 404,
};

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), partnerAgreed: z.boolean().optional() }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("finish") }),
]);

function rateLimited(eventId: string, userId: string): NextResponse | null {
  const { allowed, retryAfterSeconds } = checkRateLimit({ key: `webinar-stream-recording:${eventId}`, limit: 60, windowMs: 3600_000 });
  if (allowed) return null;
  apiLogger.warn({ eventId, userId }, "webinar-stream-recording:rate-limited");
  return NextResponse.json(
    { error: "Too many requests", retryAfterSeconds, limit: 60, windowSeconds: 3600 },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

/** Whether the stream server took the change; only a failure is worth a line to the producer. */
function serverAnswer(server: ServerOutcome | undefined): { ok: true } | { ok: false; error: string } {
  if (!server || server.ok) return { ok: true };
  return { ok: false, error: server.message };
}

function answer(result: StreamRecordingResult): NextResponse {
  // The service has already logged the refusal.
  if (!result.ok) return NextResponse.json({ error: result.message, code: result.code }, { status: STATUS[result.code] });
  return NextResponse.json({ recording: result.recording, server: serverAnswer(result.server) });
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const route = "events/[eventId]/webinar/partner-stream/recording:GET";
    const orgGuard = requireOrgId(session, { route });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route, eventId });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
      const found = await findPartnerWebinar(gate, { eventId, userId: session.user.id, route });
      if (!found.ok) return found.response;
      const recording = await getStreamRecording({ eventId, sessionId: found.sessionId });
      // `available` is whether a recording can be started here; one already made is shown either way,
      // so it can still be finished with the switch off.
      return NextResponse.json({ available: streamRecordingAvailable(), recording });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-stream-recording:read-failed");
    return NextResponse.json({ error: "Failed to read the recording" }, { status: 500 });
  }
}

/** Start (or carry on), stop for now, or finish for good. */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const route = "events/[eventId]/webinar/partner-stream/recording:POST";
    const orgGuard = requireOrgId(session, { route });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route, eventId });
    if (!gate.ok) return gate.response;

    const limited = rateLimited(eventId, session.user.id);
    if (limited) return limited;

    const validated = actionSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ eventId, errors: validated.error.flatten() }, "webinar-stream-recording:validation-failed");
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const found = await findPartnerWebinar(gate, { eventId, userId: session.user.id, route });
      if (!found.ok) return found.response;
      const caller = { organizationId: orgGuard.orgId, eventId, sessionId: found.sessionId, userId: session.user.id, source: "rest" as const };
      const input = validated.data;
      if (input.action === "start") return answer(await startStreamRecording({ ...caller, partnerAgreed: input.partnerAgreed }));
      if (input.action === "stop") return answer(await stopStreamRecording(caller));
      return answer(await finishStreamRecording({ ...caller, reason: "staff" }));
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-stream-recording:change-failed");
    return NextResponse.json({ error: "Failed to change the recording" }, { status: 500 });
  }
}

/** Delete a closed recording and its files (confirmed in the console, audited). The webinar can be recorded again after. */
export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const route = "events/[eventId]/webinar/partner-stream/recording:DELETE";
    const orgGuard = requireOrgId(session, { route });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route, eventId });
    if (!gate.ok) return gate.response;

    const limited = rateLimited(eventId, session.user.id);
    if (limited) return limited;

    return await runWithTenant(orgGuard.orgId, async () => {
      const found = await findPartnerWebinar(gate, { eventId, userId: session.user.id, route });
      if (!found.ok) return found.response;
      const result = await deleteStreamRecording({
        organizationId: orgGuard.orgId,
        eventId,
        sessionId: found.sessionId,
        userId: session.user.id,
        source: "rest",
        reason: "staff",
      });
      // The service has already logged a refusal.
      if (!result.ok) return NextResponse.json({ error: result.message, code: result.code }, { status: STATUS[result.code] });
      return NextResponse.json({ deleted: true, filesLeft: result.filesLeft });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-stream-recording:delete-failed");
    return NextResponse.json({ error: "Failed to delete the recording" }, { status: 500 });
  }
}
