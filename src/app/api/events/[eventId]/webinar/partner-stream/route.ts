import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { apiLogger } from "@/lib/logger";
import { can } from "@/lib/permissions/can";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { partnerStreamReadiness } from "@/lib/webinar/partner-stream-readiness";
import {
  cutExternalStream,
  externalStreamSignal,
  getExternalStream,
  issueExternalStream,
  replaceExternalStreamKey,
  setExternalStreamEnabled,
  updateExternalStreamDetails,
  type ExternalStreamResult,
} from "@/services/external-stream-service";
import { findPartnerWebinar, partnerStreamRefusal } from "./shared";

type RouteParams = { params: Promise<{ eventId: string }> };

/**
 * The console's Partner stream card (Nov 16, 2026; external streams step 5,
 * docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md §4.4). Reads and changes the
 * partner's key, never shows it: the key and its password come only from
 * POST ./credentials, for a holder of "See Zoom host details".
 */

const issuedToField = z.string().max(200).nullable().optional();
/** An ISO date as a Date; null (follow the session again) and undefined (leave it) pass through. */
function toDateOrKeep(v: string | null | undefined): Date | null | undefined {
  if (typeof v !== "string") return v;
  return new Date(v);
}

// An ISO date, or null to make the key follow the session again (24 hours after its scheduled end).
const validUntilField = z.string().datetime({ offset: true }).nullable().optional().transform(toDateOrKeep);

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("issue"), issuedTo: issuedToField, validUntil: validUntilField }),
  z.object({ action: z.literal("replace") }),
  z.object({ action: z.literal("cut") }),
  z.object({ action: z.literal("switch-on") }),
]);

const detailsSchema = z
  .object({ issuedTo: issuedToField, validUntil: validUntilField })
  .refine((d) => d.issuedTo !== undefined || d.validUntil !== undefined, { message: "Nothing to change" });

function rateLimited(eventId: string, userId: string): NextResponse | null {
  const { allowed, retryAfterSeconds } = checkRateLimit({ key: `webinar-partner-stream:${eventId}`, limit: 60, windowMs: 3600_000 });
  if (allowed) return null;
  apiLogger.warn({ eventId, userId }, "webinar-partner-stream:rate-limited");
  return NextResponse.json(
    { error: "Too many requests", retryAfterSeconds, limit: 60, windowSeconds: 3600 },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

/** The answer to every change: the stream's state, and whether ending the running stream worked when one was asked. */
function changed(result: Extract<ExternalStreamResult, { ok: true }>): NextResponse {
  const disconnect = result.disconnect;
  return NextResponse.json({
    partnerStream: result.externalStream,
    ...(disconnect ? { disconnect: disconnect.ok ? { ok: true, disconnected: disconnect.disconnected } : { ok: false, error: disconnect.message } } : {}),
  });
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const route = "events/[eventId]/webinar/partner-stream:GET";
    const orgGuard = requireOrgId(session, { route });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route, eventId });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
      const found = await findPartnerWebinar(gate.eventWhere, { eventId, userId: session.user.id, route });
      if (!found.ok) return found.response;
      const at = { eventId, sessionId: found.sessionId };
      const [partnerStream, signal] = await Promise.all([getExternalStream(at), externalStreamSignal(at)]);
      return NextResponse.json({
        partnerStream,
        signal,
        // Whether this server can issue and cut a key at all (an owner step when not).
        serverReady: partnerStreamReadiness().ready,
        canSeeKey: can(gate.principal, "zoomHost.view"),
      });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-partner-stream:read-failed");
    return NextResponse.json({ error: "Failed to read the partner stream" }, { status: 500 });
  }
}

/** Issue the key, replace it, cut the feed, or switch the key back on. */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const route = "events/[eventId]/webinar/partner-stream:POST";
    const orgGuard = requireOrgId(session, { route });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route, eventId });
    if (!gate.ok) return gate.response;

    const limited = rateLimited(eventId, session.user.id);
    if (limited) return limited;

    const validated = actionSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ eventId, errors: validated.error.flatten() }, "webinar-partner-stream:validation-failed");
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const found = await findPartnerWebinar(gate.eventWhere, { eventId, userId: session.user.id, route });
      if (!found.ok) return found.response;
      const caller = { organizationId: orgGuard.orgId, eventId, sessionId: found.sessionId, userId: session.user.id, source: "rest" as const };
      const input = validated.data;
      let result: ExternalStreamResult;
      if (input.action === "issue") {
        result = await issueExternalStream({ ...caller, issuedTo: input.issuedTo, validUntil: input.validUntil });
      } else if (input.action === "replace") {
        result = await replaceExternalStreamKey(caller);
      } else if (input.action === "cut") {
        result = await cutExternalStream(caller);
      } else {
        result = await setExternalStreamEnabled({ ...caller, enabled: true });
      }
      if (!result.ok) return partnerStreamRefusal(result);
      return changed(result);
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-partner-stream:change-failed");
    return NextResponse.json({ error: "Failed to change the partner stream" }, { status: 500 });
  }
}

/** Who the key was given to, and when it stops working. */
export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const route = "events/[eventId]/webinar/partner-stream:PATCH";
    const orgGuard = requireOrgId(session, { route });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route, eventId });
    if (!gate.ok) return gate.response;

    const limited = rateLimited(eventId, session.user.id);
    if (limited) return limited;

    const validated = detailsSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ eventId, errors: validated.error.flatten() }, "webinar-partner-stream:details-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const found = await findPartnerWebinar(gate.eventWhere, { eventId, userId: session.user.id, route });
      if (!found.ok) return found.response;
      const result = await updateExternalStreamDetails({
        organizationId: orgGuard.orgId,
        eventId,
        sessionId: found.sessionId,
        userId: session.user.id,
        source: "rest",
        issuedTo: validated.data.issuedTo,
        validUntil: validated.data.validUntil,
      });
      if (!result.ok) return partnerStreamRefusal(result);
      return changed(result);
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-partner-stream:details-failed");
    return NextResponse.json({ error: "Failed to change the partner stream" }, { status: 500 });
  }
}
