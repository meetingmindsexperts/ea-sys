/**
 * Event postponement: move the whole schedule by N calendar days.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * Two guards, each individually right, produced a deadlock nobody noticed:
 * the event PUT refuses a date change that would leave a session outside the
 * new dates (SESSIONS_OUTSIDE_NEW_DATES, Aug 17 2026), and the session
 * service refuses to move a session outside the CURRENT event dates
 * (OUTSIDE_EVENT_DATES). So for a postponement neither side can move first,
 * and an organiser's only exit was to delete every session, change the dates,
 * and rebuild the agenda. Found when a live event was postponed (Sep 2, 2026).
 *
 * ── What it does ─────────────────────────────────────────────────────────
 * Inside the caller's transaction, AFTER the Event row's dates have been
 * updated (so the row lock is already held):
 *   1. every session moves `dayDelta` calendar days in the event's timezone,
 *      wall-clock preserved (09:00 stays 09:00), cancelled and break items
 *      included so the agenda stays consistent if something is un-cancelled;
 *   2. the still-active sessions are re-validated against the NEW window, and
 *      any that remain outside (the event got shorter as well as later) abort
 *      the whole transaction via ScheduleShiftBlockedError, naming them at
 *      their SHIFTED times so the message says where they would have landed;
 *   3. pricing-tier sales windows and the two submission deadlines move under
 *      ONE rule: dates in the future move with the event, dates in the past
 *      stay. That never reopens an Early Bird that already closed, never closes
 *      a Standard window that is open today, and keeps Onsite ending on the
 *      last day. Not shifting them silently closes public registration for the
 *      gap between the old last day and the new one; shifting them blindly
 *      reopens discounts people already paid past. The rule is the only
 *      version that gets both right.
 *
 * Deliberately NOT shifted: dinner dates, accommodation nights, manually
 * scheduled emails. A postponement does not decide those.
 *
 * Zoom meetings are NOT touched here. The caller re-syncs them post-commit
 * (session-service.syncZoomMeetingTimes, failure-isolated) because an external
 * API call inside a transaction holds the lock for the round trip and cannot
 * be rolled back anyway.
 */
import type { Prisma } from "@prisma/client";
import { apiLogger } from "@/lib/logger";
import { isSessionWithinEventDates, shiftInstantByCalendarDays } from "@/lib/event-time";
import { readAbstractDeadline, readSessionProposalDeadline } from "@/lib/submission-deadline";

/** "Dates in the future move with the event; dates in the past stay." */
export function shiftDateUnderRule(
  date: Date | null,
  days: number,
  timeZone: string,
  now: Date,
): Date | null {
  if (!date) return null;
  if (date.getTime() <= now.getTime()) return date;
  return shiftInstantByCalendarDays(date, days, timeZone);
}

export interface BlockedSession {
  id: string;
  name: string;
  /** Where the session WOULD have landed, so the error names the real conflict. */
  startTime: Date;
  endTime: Date;
}

/** Thrown inside the transaction so the caller's `tx.event.update` rolls back too. */
export class ScheduleShiftBlockedError extends Error {
  readonly sessions: BlockedSession[];
  constructor(sessions: BlockedSession[]) {
    super("SESSIONS_OUTSIDE_NEW_DATES");
    this.name = "ScheduleShiftBlockedError";
    this.sessions = sessions;
  }
}

export interface ApplyScheduleShiftInput {
  eventId: string;
  dayDelta: number;
  timeZone: string;
  newStart: Date;
  newEnd: Date;
  /** Injected so the "past stays" rule is testable. */
  now: Date;
  /**
   * Deadlines the caller's request set to a NEW value. Those are the
   * organiser's choice and are left alone; an unchanged (echoed) value is
   * shifted from the stored one. The same "computed change, not field
   * presence" lesson the M9 guard learnt (July 16, 2026): the General tab
   * echoes both deadlines on every save.
   */
  explicitlyChangedDeadlines: { abstract: boolean; sessionProposal: boolean };
}

export interface ShiftedZoomSession {
  sessionId: string;
  zoomMeeting: { id: string; zoomMeetingId: string; meetingType: string };
  startTime: Date;
  endTime: Date;
}

export interface ScheduleShiftSummary {
  dayDelta: number;
  sessionsMoved: number;
  tiersMoved: number;
  deadlinesMoved: Array<"abstractDeadline" | "sessionProposalDeadline">;
  /** For the caller's post-commit Zoom re-sync. */
  zoomSessions: ShiftedZoomSession[];
}

const SESSION_SELECT = {
  id: true,
  name: true,
  startTime: true,
  endTime: true,
  status: true,
  zoomMeeting: { select: { id: true, zoomMeetingId: true, meetingType: true } },
} as const;

export async function applyScheduleShift(
  tx: Prisma.TransactionClient,
  input: ApplyScheduleShiftInput,
): Promise<ScheduleShiftSummary> {
  const { eventId, dayDelta, timeZone, newStart, newEnd, now } = input;

  // 1 + 2. Sessions: shift all, validate the active ones, abort on any miss.
  const sessions = await tx.eventSession.findMany({ where: { eventId }, select: SESSION_SELECT });
  const shifted = sessions.map((s) => ({
    ...s,
    startTime: shiftInstantByCalendarDays(s.startTime, dayDelta, timeZone),
    endTime: shiftInstantByCalendarDays(s.endTime, dayDelta, timeZone),
  }));
  const blocked = shifted.filter(
    (s) =>
      s.status !== "CANCELLED" &&
      !isSessionWithinEventDates(s.startTime, s.endTime, newStart, newEnd, timeZone),
  );
  if (blocked.length > 0) {
    throw new ScheduleShiftBlockedError(
      blocked.map((s) => ({ id: s.id, name: s.name, startTime: s.startTime, endTime: s.endTime })),
    );
  }
  for (const s of shifted) {
    await tx.eventSession.update({
      where: { id: s.id, eventId },
      data: { startTime: s.startTime, endTime: s.endTime },
    });
  }

  // 3a. Tier sales windows under the future-moves rule.
  const tiers = await tx.pricingTier.findMany({
    where: { ticketType: { eventId } },
    select: { id: true, salesStart: true, salesEnd: true },
  });
  let tiersMoved = 0;
  for (const t of tiers) {
    const salesStart = shiftDateUnderRule(t.salesStart, dayDelta, timeZone, now);
    const salesEnd = shiftDateUnderRule(t.salesEnd, dayDelta, timeZone, now);
    const changed =
      (salesStart?.getTime() ?? null) !== (t.salesStart?.getTime() ?? null) ||
      (salesEnd?.getTime() ?? null) !== (t.salesEnd?.getTime() ?? null);
    if (!changed) continue;
    await tx.pricingTier.update({ where: { id: t.id }, data: { salesStart, salesEnd } });
    tiersMoved += 1;
  }

  // 3b. The two submission deadlines, same rule, skipping any the request set.
  // The Event row is already locked by the caller's dates update, so this
  // read-modify-write cannot be interleaved by another settings writer.
  const row = await tx.event.findUnique({ where: { id: eventId }, select: { settings: true } });
  const settings =
    row?.settings && typeof row.settings === "object" && !Array.isArray(row.settings)
      ? { ...(row.settings as Record<string, unknown>) }
      : {};
  const deadlinesMoved: ScheduleShiftSummary["deadlinesMoved"] = [];
  const shiftDeadline = (
    key: "abstractDeadline" | "sessionProposalDeadline",
    read: (s: unknown) => string | null,
    explicitlyChanged: boolean,
  ) => {
    if (explicitlyChanged) return;
    const current = read(settings);
    if (!current) return;
    const moved = shiftDateUnderRule(new Date(current), dayDelta, timeZone, now);
    if (!moved || moved.getTime() === new Date(current).getTime()) return;
    settings[key] = moved.toISOString();
    deadlinesMoved.push(key);
  };
  shiftDeadline("abstractDeadline", readAbstractDeadline, input.explicitlyChangedDeadlines.abstract);
  shiftDeadline(
    "sessionProposalDeadline",
    readSessionProposalDeadline,
    input.explicitlyChangedDeadlines.sessionProposal,
  );
  if (deadlinesMoved.length > 0) {
    await tx.event.update({
      where: { id: eventId },
      data: { settings: settings as Prisma.InputJsonValue },
    });
  }

  const zoomSessions: ShiftedZoomSession[] = shifted
    .filter((s) => s.zoomMeeting)
    .map((s) => ({
      sessionId: s.id,
      zoomMeeting: s.zoomMeeting as ShiftedZoomSession["zoomMeeting"],
      startTime: s.startTime,
      endTime: s.endTime,
    }));

  apiLogger.info({
    msg: "event-schedule-shift:applied",
    eventId,
    dayDelta,
    sessionsMoved: shifted.length,
    tiersMoved,
    deadlinesMoved,
    zoomSessions: zoomSessions.length,
  });

  return { dayDelta, sessionsMoved: shifted.length, tiersMoved, deadlinesMoved, zoomSessions };
}
