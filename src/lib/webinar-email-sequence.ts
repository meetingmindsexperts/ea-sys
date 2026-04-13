import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { readWebinarSettings } from "@/lib/webinar";
import { WEBINAR_EMAIL_TYPES, executeBulkEmail } from "@/lib/bulk-email";

// Minimum lead time before a phase fires. A "reminder-24h" scheduled for 5 min
// from now is useless, so if we're too close to an anchor time we skip that phase.
const MIN_LEAD_MS = 60_000;

export type WebinarPhase =
  | "webinar-reminder-24h"
  | "webinar-reminder-1h"
  | "webinar-live-now"
  | "webinar-thank-you";

interface PhaseTiming {
  phase: WebinarPhase;
  scheduledFor: Date;
}

function computePhases(startTime: Date, endTime: Date): PhaseTiming[] {
  const now = Date.now();
  const phases: PhaseTiming[] = [
    { phase: "webinar-reminder-24h", scheduledFor: new Date(startTime.getTime() - 24 * 60 * 60_000) },
    { phase: "webinar-reminder-1h", scheduledFor: new Date(startTime.getTime() - 60 * 60_000) },
    { phase: "webinar-live-now", scheduledFor: new Date(startTime.getTime()) },
    { phase: "webinar-thank-you", scheduledFor: new Date(endTime.getTime() + 30 * 60_000) },
  ];
  // Drop phases whose scheduledFor is already in the past (too late to send).
  return phases.filter((p) => p.scheduledFor.getTime() > now + MIN_LEAD_MS);
}

/**
 * Resolve a user id to act as the "creator" of auto-enqueued sequence rows.
 * Prefers an explicit actor, falls back to the first ADMIN/ORGANIZER of the org.
 * Returns null if no suitable user exists (should not happen in single-org mode).
 */
async function resolveSequenceActor(
  organizationId: string,
  preferredUserId?: string,
): Promise<string | null> {
  if (preferredUserId) {
    const user = await db.user.findFirst({
      where: { id: preferredUserId, organizationId },
      select: { id: true },
    });
    if (user) return user.id;
  }
  const fallback = await db.user.findFirst({
    where: {
      organizationId,
      role: { in: ["ADMIN", "SUPER_ADMIN", "ORGANIZER"] },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return fallback?.id ?? null;
}

export interface EnqueueSequenceResult {
  ok: boolean;
  created: number;
  skipped: "already-enqueued" | "no-anchor-session" | "no-actor" | "no-future-phases" | null;
}

/**
 * Create the 4 future-phase ScheduledEmail rows (reminder-24h, reminder-1h,
 * live-now, thank-you) for a webinar event. Idempotent: if ANY webinar-* row
 * already exists for this event, returns { skipped: "already-enqueued" } and
 * creates nothing. To re-enqueue after a schedule change, delete existing rows
 * via the /webinar/sequence POST route first.
 */
export async function enqueueWebinarSequenceForEvent(
  eventId: string,
  actorUserId?: string,
): Promise<EnqueueSequenceResult> {
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: { id: true, organizationId: true, settings: true },
  });
  if (!event) {
    return { ok: false, created: 0, skipped: null };
  }

  const webinarSettings = readWebinarSettings(event.settings);
  const anchorSessionId = webinarSettings?.sessionId;
  if (!anchorSessionId) {
    return { ok: false, created: 0, skipped: "no-anchor-session" };
  }

  // Idempotency: look up any existing webinar-* row for this event.
  const existing = await db.scheduledEmail.findFirst({
    where: {
      eventId,
      emailType: { in: [...WEBINAR_EMAIL_TYPES] },
    },
    select: { id: true },
  });
  if (existing) {
    apiLogger.info({ eventId }, "webinar-sequence:already-enqueued");
    return { ok: true, created: 0, skipped: "already-enqueued" };
  }

  const anchorSession = await db.eventSession.findFirst({
    where: { id: anchorSessionId, eventId },
    select: { startTime: true, endTime: true },
  });
  if (!anchorSession) {
    return { ok: false, created: 0, skipped: "no-anchor-session" };
  }

  const phases = computePhases(anchorSession.startTime, anchorSession.endTime);
  if (phases.length === 0) {
    apiLogger.info({ eventId }, "webinar-sequence:no-future-phases");
    return { ok: true, created: 0, skipped: "no-future-phases" };
  }

  const createdById = await resolveSequenceActor(event.organizationId, actorUserId);
  if (!createdById) {
    apiLogger.warn({ eventId }, "webinar-sequence:no-actor-user-found");
    return { ok: false, created: 0, skipped: "no-actor" };
  }

  // Create one ScheduledEmail per phase. Recipients re-evaluated at fire time
  // via filter { status: CONFIRMED }, so cancellations + late registrations
  // are handled correctly.
  await db.scheduledEmail.createMany({
    data: phases.map((p) => ({
      eventId,
      organizationId: event.organizationId,
      createdById,
      recipientType: "registrations",
      emailType: p.phase,
      filters: { status: "CONFIRMED" },
      scheduledFor: p.scheduledFor,
    })),
  });

  apiLogger.info(
    { eventId, createdById, phases: phases.map((p) => p.phase) },
    "webinar-sequence:enqueued",
  );

  return { ok: true, created: phases.length, skipped: null };
}

/**
 * Send the webinar-confirmation email for a single registration immediately.
 * Used by the public register route so the registrant gets their join link
 * in their inbox within seconds of completing the form — no cron latency.
 *
 * Throws on failure; caller should catch and log non-fatally (like the
 * existing sendRegistrationConfirmation call).
 */
export async function sendWebinarConfirmationForRegistration(args: {
  eventId: string;
  registrationId: string;
  organizerName: string;
  organizerEmail: string;
}): Promise<void> {
  const result = await executeBulkEmail({
    eventId: args.eventId,
    recipientType: "registrations",
    recipientIds: [args.registrationId],
    emailType: "webinar-confirmation",
    organizerName: args.organizerName,
    organizerEmail: args.organizerEmail,
  });
  if (result.failureCount > 0) {
    throw new Error(
      result.errors[0]?.error || "Failed to send webinar confirmation",
    );
  }
  apiLogger.info(
    { eventId: args.eventId, registrationId: args.registrationId, total: result.total },
    "webinar-sequence:confirmation-sent",
  );
}

/**
 * Delete all webinar sequence rows for an event that haven't been sent yet.
 * Used by the /webinar/sequence POST route to re-enqueue after schedule changes.
 * Returns count of rows deleted.
 */
export async function clearPendingWebinarSequence(eventId: string): Promise<number> {
  const result = await db.scheduledEmail.deleteMany({
    where: {
      eventId,
      emailType: { in: [...WEBINAR_EMAIL_TYPES] },
      status: { in: ["PENDING", "FAILED", "CANCELLED"] },
    },
  });
  return result.count;
}
