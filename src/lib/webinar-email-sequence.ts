import type { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
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

/** The 4 auto-sequence phases. Deliberately NOT WEBINAR_EMAIL_TYPES — that
 * list also carries webinar-confirmation, which organizers schedule MANUALLY
 * (send join links at 9am); the sequence machinery must never touch it. */
export const WEBINAR_SEQUENCE_PHASES: readonly WebinarPhase[] = [
  "webinar-reminder-24h",
  "webinar-reminder-1h",
  "webinar-live-now",
  "webinar-thank-you",
];

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
  preferredUserId: string | undefined,
  client: Prisma.TransactionClient | typeof db,
): Promise<string | null> {
  if (preferredUserId) {
    const user = await client.user.findFirst({
      where: { id: preferredUserId, organizationId },
      select: { id: true },
    });
    if (user) return user.id;
  }
  const fallback = await client.user.findFirst({
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
 * creates nothing.
 *
 * `force: true` (Aug 4, 2026 — the retime-reschedule fix) skips that guard so
 * the sequence can be re-created after a schedule change; phases that already
 * fired (SENT/PROCESSING), were deliberately CANCELLED by an operator (unless
 * `resurrectCancelled`), or FAILED mid-send with some emails delivered are
 * still excluded so no recipient ever gets a phase twice and no operator
 * decision is silently undone. Callers must clear pending rows first — use
 * rescheduleWebinarSequenceForEvent, which does both under a per-event lock.
 */
async function enqueueSequenceInner(
  eventId: string,
  actorUserId?: string,
  opts?: { force?: boolean; resurrectCancelled?: boolean; tx?: Prisma.TransactionClient },
): Promise<EnqueueSequenceResult> {
  const client = opts?.tx ?? db;
  const event = await client.event.findUnique({
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
  // Skipped under force — the reschedule path clears pending rows first and
  // relies on the per-phase fired/cancelled exclusion below instead.
  if (!opts?.force) {
    const existing = await client.scheduledEmail.findFirst({
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
  }

  const anchorSession = await client.eventSession.findFirst({
    where: { id: anchorSessionId, eventId },
    select: { startTime: true, endTime: true },
  });
  if (!anchorSession) {
    return { ok: false, created: 0, skipped: "no-anchor-session" };
  }

  let phases = computePhases(anchorSession.startTime, anchorSession.endTime);

  if (opts?.force && phases.length > 0) {
    // Never duplicate or resurrect a phase:
    //  - SENT/PROCESSING: it fired (or is firing) — re-creating would double-
    //    email the audience.
    //  - CANCELLED: an operator deliberately killed it (dashboard cancel /
    //    MCP) — an automatic retime must not undo that decision (review M1).
    //    The console's explicit Re-enqueue passes resurrectCancelled.
    //  - FAILED with some emails already delivered: the row carries the
    //    emailedKeys resume state; a fresh row would re-email the delivered
    //    portion (review M2). Operators resume it via Retry instead.
    const firedRows = await client.scheduledEmail.findMany({
      where: {
        eventId,
        emailType: { in: phases.map((p) => p.phase) },
        status: { in: ["SENT", "PROCESSING", "CANCELLED", "FAILED"] },
      },
      select: { emailType: true, status: true, emailedKeys: true },
    });
    const fired = new Set(
      firedRows
        .filter((r) => {
          if (r.status === "SENT" || r.status === "PROCESSING") return true;
          if (r.status === "CANCELLED") return !opts?.resurrectCancelled;
          return r.emailedKeys.length > 0; // FAILED
        })
        .map((r) => r.emailType),
    );
    if (fired.size > 0) {
      apiLogger.info(
        { eventId, skippedFiredPhases: [...fired] },
        "webinar-sequence:reschedule-skips-fired-phases",
      );
      phases = phases.filter((p) => !fired.has(p.phase));
    }
  }

  if (phases.length === 0) {
    apiLogger.info({ eventId }, "webinar-sequence:no-future-phases");
    return { ok: true, created: 0, skipped: "no-future-phases" };
  }

  const createdById = await resolveSequenceActor(event.organizationId, actorUserId, client);
  if (!createdById) {
    apiLogger.warn({ eventId }, "webinar-sequence:no-actor-user-found");
    return { ok: false, created: 0, skipped: "no-actor" };
  }

  // Create one ScheduledEmail per phase. Recipients re-evaluated at fire time
  // via filter { status: CONFIRMED }, so cancellations + late registrations
  // are handled correctly.
  await client.scheduledEmail.createMany({
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
 * Public entry. When called WITHOUT a caller-supplied `tx` (the provisioner's
 * direct call at create / reattach / already-attached), serialize on the SAME
 * per-event advisory lock `rescheduleWebinarSequenceForEvent` takes. Without
 * this, the non-force idempotency check (findFirst → createMany) is an unlocked
 * check-then-act: a provisioner enqueue racing a retime-reschedule, or two
 * concurrent "Run provisioner" clicks on a zero-row webinar, both see "no rows"
 * under READ COMMITTED and each createMany the full 4-phase set — every reminder
 * fires TWICE to the whole audience (there is no @@unique on (eventId,emailType)
 * to collide on). When a `tx` IS supplied, the caller (reschedule) already holds
 * the lock inside its transaction, so we run the body directly.
 */
export async function enqueueWebinarSequenceForEvent(
  eventId: string,
  actorUserId?: string,
  opts?: { force?: boolean; resurrectCancelled?: boolean; tx?: Prisma.TransactionClient },
): Promise<EnqueueSequenceResult> {
  if (opts?.tx) {
    return enqueueSequenceInner(eventId, actorUserId, opts);
  }
  return tenantTransaction(async (tx) => {
    // ::text cast — pg_advisory_xact_lock returns void, which Prisma's $queryRaw
    // cannot deserialize (same shape as reschedule, Aug 6 2026).
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`webinar-seq:${eventId}`}))::text`;
    return enqueueSequenceInner(eventId, actorUserId, { ...opts, tx });
  });
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
 * Reschedule the webinar sequence off the anchor session's CURRENT times:
 * clears re-creatable rows, then re-enqueues under force. The one call every
 * retime path uses — session-service on an anchor retime, the event PUT
 * cascade, and the console's Re-enqueue button — so they can't drift.
 *
 * SERIALIZED per event (review H-1): clear + create run inside ONE
 * tenantTransaction holding a transaction-scoped advisory lock keyed on the
 * eventId. ScheduledEmail has no unique on (eventId, emailType), so two
 * interleaved reschedules (Settings cascade racing an Agenda retime, a
 * double-clicked Re-enqueue) would otherwise each create a full phase set —
 * every reminder firing twice to the whole audience. pg_advisory_xact_lock is
 * the pooler-safe variant: the lock and the statements share one backend for
 * the transaction's lifetime (unlike session-scoped locks, which pgbouncer's
 * transaction mode can strand on another backend — the P3 lesson).
 *
 * `resurrectCancelled` is the console Re-enqueue's explicit-operator-action
 * semantics: it may re-create phases an operator cancelled; the automatic
 * retime hooks never do (review M1).
 *
 * A failure between clear and create leaves ZERO pending rows (loud, visible
 * in the console's sequence card) rather than rows at the wrong time — and
 * under the transaction the clear rolls back with the failed create anyway.
 */
export async function rescheduleWebinarSequenceForEvent(
  eventId: string,
  actorUserId?: string,
  opts?: { resurrectCancelled?: boolean },
): Promise<EnqueueSequenceResult & { cleared: number }> {
  const out = await tenantTransaction(async (tx) => {
    // ::text cast — pg_advisory_xact_lock returns `void`, which Prisma 6.19's
    // $queryRaw cannot deserialize; the bare form THREW here, making every
    // retime's email-reschedule report "failed" (found via the group-register
    // live smoke, Aug 6 2026 — same lock shape).
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`webinar-seq:${eventId}`}))::text`;
    const cleared = await clearPendingWebinarSequence(eventId, {
      resurrectCancelled: opts?.resurrectCancelled,
      tx,
    });
    const result = await enqueueWebinarSequenceForEvent(eventId, actorUserId, {
      force: true,
      resurrectCancelled: opts?.resurrectCancelled,
      tx,
    });
    return { ...result, cleared };
  });
  apiLogger.info(
    { eventId, cleared: out.cleared, created: out.created, skipped: out.skipped },
    "webinar-sequence:rescheduled",
  );
  return out;
}

/**
 * Delete the AUTO-SEQUENCE rows that are safe to re-create (review M1/M2/M3):
 *  - only the 4 phase types — never webinar-confirmation, which organizers
 *    schedule manually ("send join links at 9am");
 *  - only sequence-minted rows (no custom subject/message, no explicit
 *    recipient list) — a manually composed reminder is the organizer's own
 *    scheduled send, not ours to delete;
 *  - PENDING always; FAILED only when nothing was delivered yet (a partial
 *    send's emailedKeys resume state must survive for Retry); CANCELLED only
 *    under the console's explicit resurrectCancelled.
 * Returns count of rows deleted.
 */
export async function clearPendingWebinarSequence(
  eventId: string,
  opts?: { resurrectCancelled?: boolean; tx?: Prisma.TransactionClient },
): Promise<number> {
  const client = opts?.tx ?? db;
  const result = await client.scheduledEmail.deleteMany({
    where: {
      eventId,
      emailType: { in: [...WEBINAR_SEQUENCE_PHASES] },
      customSubject: null,
      customMessage: null,
      recipientIds: { isEmpty: true },
      OR: [
        { status: "PENDING" },
        { status: "FAILED", emailedKeys: { isEmpty: true } },
        ...(opts?.resurrectCancelled ? [{ status: "CANCELLED" as const }] : []),
      ],
    },
  });
  return result.count;
}
