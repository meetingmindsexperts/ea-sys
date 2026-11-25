import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { findGatedEvent } from "@/lib/tenant/event-tenant";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { WEBINAR_EMAIL_TYPES } from "@/lib/bulk-email";
import { isSequenceScheduled, rescheduleWebinarSequenceForEvent } from "@/lib/webinar-email-sequence";
import {
  phasesSwitchedOn,
  readSequencePlan,
  SEQUENCE_PHASES,
  sequencePlanSchema,
  storedSequencePlan,
  type PhaseChoice,
  type SequencePhase,
} from "@/lib/webinar-sequence-plan";
import { updateEventSettings } from "@/lib/event-settings";
import { rateLimited } from "@/lib/api-errors";

/**
 * The webinar's email sequence (Nov 25, 2026; owner: "make it manual, let the organiser decide").
 *   GET   the queued rows, the organiser's plan (pre-filled with the five usual emails) and whether
 *         it is scheduled.
 *   PUT   { phases }: save which emails go and when, and schedule them (clear the pending rows,
 *         create the chosen ones). The one way a new webinar's sequence starts.
 *   POST  schedule the plan as it stands (the console's old Re-enqueue; kept for API callers).
 * Both writes need `webinar.manage`, are for a webinar only, and count as the organiser confirming
 * the plan.
 */
const WRITE_LIMIT = 30;
const WRITE_WINDOW_S = 3600;

async function schedulePlan(
  eventId: string,
  userId: string,
  organizationId: string,
  plan: { phases: Record<SequencePhase, PhaseChoice>; previous: Record<SequencePhase, PhaseChoice>; revivePhases: readonly SequencePhase[] },
) {
  const { phases } = plan;
  // In the organisation's lane where it is written (both callers are already in it).
  await runWithTenant(organizationId, () =>
    updateEventSettings(eventId, (current) => {
      const currentWebinar = current.webinar && typeof current.webinar === "object" ? (current.webinar as Record<string, unknown>) : {};
      return { ...current, webinar: { ...currentWebinar, sequence: storedSequencePlan(phases, true) } };
    }),
  );
  const result = await rescheduleWebinarSequenceForEvent(eventId, userId, { revivePhases: plan.revivePhases });
  db.auditLog
    .create({
      data: {
        organizationId,
        eventId,
        userId,
        action: "WEBINAR_SEQUENCE_SCHEDULED",
        entityType: "Event",
        entityId: eventId,
        changes: { before: plan.previous, phases, revived: plan.revivePhases, created: result.created, cleared: result.cleared, source: "rest" } as never,
      },
    })
    .catch((err: unknown) => apiLogger.error({ err, eventId }, "webinar-sequence:audit-failed"));
  return result;
}

type RouteParams = { params: Promise<{ eventId: string }> };

function notAWebinar(eventId: string, userId: string) {
  apiLogger.warn({ eventId, userId }, "webinar-sequence:not-a-webinar");
  return NextResponse.json({ error: "The email sequence is for webinars.", code: "NOT_A_WEBINAR" }, { status: 400 });
}

// ── GET — List webinar sequence rows for an event ─────────────────

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar/sequence:GET" });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.analytics.read", { route: "events/[eventId]/webinar/sequence:GET", eventId, onMissing: "hide" });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
    const event = await findGatedEvent(gate, {
      select: { id: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const [rows, scheduled] = await Promise.all([db.scheduledEmail.findMany({
      where: {
        eventId,
        emailType: { in: [...WEBINAR_EMAIL_TYPES] },
      },
      orderBy: { scheduledFor: "asc" },
      select: {
        id: true,
        emailType: true,
        status: true,
        scheduledFor: true,
        sentAt: true,
        totalCount: true,
        successCount: true,
        failureCount: true,
        lastError: true,
        retryCount: true,
      },
    }), isSequenceScheduled(eventId, event.settings)]);

    const plan = readSequencePlan(event.settings);
    return NextResponse.json({ rows, plan: { phases: plan.phases, scheduled } });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-sequence:list-failed");
    return NextResponse.json(
      { error: "Failed to list webinar sequence" },
      { status: 500 },
    );
  }
}

// ── POST — Clear pending rows and re-enqueue the sequence ─────────

export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/webinar/sequence:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "webinar.manage", { route: "events/[eventId]/webinar/sequence:POST", eventId });
    if (!gate.ok) return gate.response;

    const rl = checkRateLimit({ key: `webinar-sequence-write:${eventId}`, limit: WRITE_LIMIT, windowMs: WRITE_WINDOW_S * 1000 });
    if (!rl.allowed) {
      return rateLimited(rl, { route: "webinar-sequence", eventId, userId: session.user.id, limit: WRITE_LIMIT, windowSeconds: WRITE_WINDOW_S });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
    const event = await findGatedEvent(gate, {
      select: { id: true, settings: true, eventType: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "webinar-sequence:reenqueue-event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (event.eventType !== "WEBINAR") return notAWebinar(eventId, session.user.id);

    // Shared reschedule helper (clear + force re-enqueue under a per-event
    // lock): unlike the old clear-then-plain-enqueue pair, a phase that
    // already SENT no longer blocks re-creating the REMAINING phases.
    // An explicit API call: unlike the automatic retime hooks it MAY re-create every phase an
    // operator had cancelled (the old Re-enqueue's semantics). Scheduling the plan as it stands
    // confirms it (Nov 25, 2026).
    const current = readSequencePlan(event.settings).phases;
    const result = await schedulePlan(eventId, session.user.id, orgGuard.orgId, { phases: current, previous: current, revivePhases: SEQUENCE_PHASES });
    const deleted = result.cleared;

    apiLogger.info(
      { eventId, userId: session.user.id, deleted, created: result.created, skipped: result.skipped },
      "webinar-sequence:reenqueued",
    );

    return NextResponse.json({
      ok: result.ok,
      deleted,
      created: result.created,
      skipped: result.skipped,
    });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-sequence:reenqueue-failed");
    return NextResponse.json(
      { error: "Failed to re-enqueue webinar sequence" },
      { status: 500 },
    );
  }
}

// ── PUT — Save the organiser's plan and schedule it ───────────────

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const route = "events/[eventId]/webinar/sequence:PUT";
    const orgGuard = requireOrgId(session, { route });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route, eventId });
    if (!gate.ok) return gate.response;

    const rl = checkRateLimit({ key: `webinar-sequence-write:${eventId}`, limit: WRITE_LIMIT, windowMs: WRITE_WINDOW_S * 1000 });
    if (!rl.allowed) {
      return rateLimited(rl, { route: "webinar-sequence", eventId, userId: session.user.id, limit: WRITE_LIMIT, windowSeconds: WRITE_WINDOW_S });
    }

    const parsed = sequencePlanSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ eventId, userId: session.user.id, errors: parsed.error.flatten() }, "webinar-sequence:plan-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await findGatedEvent(gate, { select: { id: true, settings: true, eventType: true } });
      if (!event) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-sequence:plan-event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      if (event.eventType !== "WEBINAR") return notAWebinar(eventId, session.user.id);
      const phases = parsed.data.phases as Record<SequencePhase, PhaseChoice>;
      const previous = readSequencePlan(event.settings).phases;
      const result = await schedulePlan(eventId, session.user.id, orgGuard.orgId, {
        phases,
        previous,
        revivePhases: phasesSwitchedOn(previous, phases, parsed.data.switchedOn),
      });
      apiLogger.info(
        { eventId, userId: session.user.id, created: result.created, cleared: result.cleared, skipped: result.skipped },
        "webinar-sequence:plan-scheduled",
      );
      return NextResponse.json({ ok: result.ok, created: result.created, deleted: result.cleared, skipped: result.skipped });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-sequence:plan-failed");
    return NextResponse.json({ error: "Failed to schedule the webinar emails" }, { status: 500 });
  }
}
