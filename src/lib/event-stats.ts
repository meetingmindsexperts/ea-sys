/**
 * Denormalized EventStats read model.
 *
 * Replaces 14+ parallel groupBy/count queries on every dashboard call
 * with a single-row read from the EventStats table.
 *
 * `refreshEventStats(eventId)` is fire-and-forget: it kicks off a full
 * recompute asynchronously and never throws to the caller. Call it after
 * any write that affects registration, speaker, session, abstract, or
 * track counts.
 *
 * Pattern matches `syncToContact()` in src/lib/contact-sync.ts.
 */

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { EventStats } from "@prisma/client";

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fire-and-forget stats refresh. Safe to call from any write path —
 * errors are logged but never propagated.
 */
export function refreshEventStats(eventId: string): void {
  _doRefresh(eventId).catch((err) =>
    apiLogger.error({ err, eventId, msg: "event-stats:refresh-failed" }),
  );
}

/**
 * Read the cached stats row. Returns null if no row exists yet
 * (event created before this feature, or never written to).
 */
export async function getEventStatsRow(
  eventId: string,
): Promise<EventStats | null> {
  return db.eventStats.findUnique({ where: { eventId } });
}

// ─── Internal ────────────────────────────────────────────────────────────────

async function _doRefresh(eventId: string): Promise<void> {
  const [
    regByStatus,
    regByPayment,
    spkByStatus,
    agreementsSigned,
    absByStatus,
    sessionCount,
    trackCount,
    checkedInCount,
  ] = await Promise.all([
    db.registration.groupBy({
      by: ["status"],
      where: { eventId },
      _count: true,
    }),
    db.registration.groupBy({
      by: ["paymentStatus"],
      where: { eventId },
      _count: true,
    }),
    db.speaker.groupBy({
      by: ["status"],
      where: { eventId },
      _count: true,
    }),
    db.speaker.count({
      where: { eventId, agreementAcceptedAt: { not: null } },
    }),
    db.abstract.groupBy({
      by: ["status"],
      where: { eventId },
      _count: true,
    }),
    db.eventSession.count({ where: { eventId } }),
    db.track.count({ where: { eventId } }),
    db.registration.count({
      where: { eventId, checkedInAt: { not: null } },
    }),
  ]);

  const registrationsByStatus = Object.fromEntries(
    regByStatus.map((r) => [r.status, r._count]),
  );
  const registrationsByPayment = Object.fromEntries(
    regByPayment.map((r) => [r.paymentStatus, r._count]),
  );
  const speakersByStatus = Object.fromEntries(
    spkByStatus.map((r) => [r.status, r._count]),
  );
  const abstractsByStatus = Object.fromEntries(
    absByStatus.map((r) => [r.status, r._count]),
  );
  const totalRegistrations = regByStatus.reduce((s, r) => s + r._count, 0);
  const totalSpeakers = spkByStatus.reduce((s, r) => s + r._count, 0);

  const data = {
    registrationsByStatus,
    registrationsByPayment,
    totalRegistrations,
    checkedInCount,
    speakersByStatus,
    totalSpeakers,
    agreementsSigned,
    abstractsByStatus,
    totalSessions: sessionCount,
    totalTracks: trackCount,
    computedAt: new Date(),
  };

  await db.eventStats.upsert({
    where: { eventId },
    create: { eventId, ...data },
    update: data,
  });
}
