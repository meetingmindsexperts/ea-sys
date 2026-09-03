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
 *      their SHIFTED times so the message says where they would have landed.
 *      The caller runs the SAME check (findSessionsOutsideAfterShift) as a
 *      read-only pre-check before any write, so this one is the race backstop;
 *   3. sales windows on both PricingTier AND TicketType (a tier-less type
 *      carries its own window, and the public register reads whichever
 *      applies), plus the two submission deadlines, move under ONE rule:
 *      dates in the future move with the event, dates in the past stay. That
 *      never reopens an Early Bird that already closed, never closes a Standard
 *      window that is open today, and keeps Onsite ending on the last day.
 *      Not shifting them silently closes public registration for the gap
 *      between the old last day and the new one; shifting them blindly reopens
 *      discounts people already paid past. The rule is the only version that
 *      gets both right.
 *   4. a CLOSING date (a sales end, a deadline) is never moved INTO the past.
 *      Bringing an event forward would otherwise close an open window or shut
 *      submissions with no signal. Such a date is left where it is and counted
 *      in `keptOpen`, so the organiser is told. Opening dates may move into the
 *      past freely: that just means the window is open now, which is what an
 *      event brought forward wants.
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

// ── The rules ─────────────────────────────────────────────────────────────

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

/**
 * The same rule for a CLOSING date (sales end, deadline), plus: never into the
 * past. A future closing date whose shifted value would already be behind us
 * stays where it is, and `keptOpen` says so.
 */
export function shiftClosingDateUnderRule(
  date: Date | null,
  days: number,
  timeZone: string,
  now: Date,
): { value: Date | null; keptOpen: boolean } {
  if (!date) return { value: null, keptOpen: false };
  if (date.getTime() <= now.getTime()) return { value: date, keptOpen: false };
  const moved = shiftInstantByCalendarDays(date, days, timeZone);
  if (moved.getTime() <= now.getTime()) return { value: date, keptOpen: true };
  return { value: moved, keptOpen: false };
}

export type DeadlineKey = "abstractDeadline" | "sessionProposalDeadline";

const minuteInstant = (iso: string | null): number | null =>
  iso ? Math.floor(new Date(iso).getTime() / 60_000) : null;

/**
 * Did THIS request change the deadline, as opposed to echoing the stored one?
 *
 * The General tab sends both deadlines on every save, so key presence proves
 * nothing; an ABSENT key proves nothing either (a partial patch from MCP or
 * curl must not read as "cleared"). Only a present key whose value differs
 * from what is stored is the organiser's decision. Compared at minute
 * precision because the Settings form round-trips through a minute-precision
 * input, so a stored value with seconds would otherwise read as changed on
 * every save and never shift.
 */
export function deadlineChangedInPatch(
  patch: Record<string, unknown> | undefined,
  stored: unknown,
  key: DeadlineKey,
): boolean {
  if (!patch || !(key in patch)) return false;
  const read = key === "abstractDeadline" ? readAbstractDeadline : readSessionProposalDeadline;
  return minuteInstant(read(patch)) !== minuteInstant(read(stored));
}

// ── Sessions ──────────────────────────────────────────────────────────────

export interface BlockedSession {
  id: string;
  name: string;
  /** Where the session WOULD land, so an error names the real conflict. */
  startTime: Date;
  endTime: Date;
}

/**
 * The sessions that would fall outside the new window AFTER being shifted by
 * `dayDelta` (0 = no shift, the plain date-range guard). Cancelled sessions
 * never block: they no longer render on the agenda. Rows without a `status`
 * (a narrow select) are treated as active.
 *
 * ONE implementation, used both by the route's read-only pre-check (before any
 * write) and by applyScheduleShift inside the transaction (the race backstop).
 */
export function findSessionsOutsideAfterShift<
  T extends { id: string; name: string; startTime: Date; endTime: Date; status?: string },
>(
  sessions: T[],
  opts: { dayDelta: number; timeZone: string; newStart: Date; newEnd: Date },
): BlockedSession[] {
  const { dayDelta, timeZone, newStart, newEnd } = opts;
  const out: BlockedSession[] = [];
  for (const s of sessions) {
    if ((s.status ?? "SCHEDULED") === "CANCELLED") continue;
    const startTime = shiftInstantByCalendarDays(s.startTime, dayDelta, timeZone);
    const endTime = shiftInstantByCalendarDays(s.endTime, dayDelta, timeZone);
    if (!isSessionWithinEventDates(startTime, endTime, newStart, newEnd, timeZone)) {
      out.push({ id: s.id, name: s.name, startTime, endTime });
    }
  }
  return out;
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

// ── The transactional apply ───────────────────────────────────────────────

export interface ApplyScheduleShiftInput {
  eventId: string;
  dayDelta: number;
  timeZone: string;
  newStart: Date;
  newEnd: Date;
  /** Injected so the "past stays" rule is testable. */
  now: Date;
  /** Per deadlineChangedInPatch: a deadline the request set to a NEW value is left alone. */
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
  ticketTypesMoved: number;
  deadlinesMoved: DeadlineKey[];
  /** Closing dates left in place because moving them would have closed them. */
  keptOpen: number;
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

const WINDOW_SELECT = { id: true, salesStart: true, salesEnd: true } as const;

export async function applyScheduleShift(
  tx: Prisma.TransactionClient,
  input: ApplyScheduleShiftInput,
): Promise<ScheduleShiftSummary> {
  const { eventId, dayDelta, timeZone, newStart, newEnd, now } = input;
  let keptOpen = 0;

  // 1 + 2. Sessions: validate the active ones after the move, abort on any miss,
  // then move all of them.
  const sessions = await tx.eventSession.findMany({ where: { eventId }, select: SESSION_SELECT });
  const blocked = findSessionsOutsideAfterShift(sessions, { dayDelta, timeZone, newStart, newEnd });
  if (blocked.length > 0) throw new ScheduleShiftBlockedError(blocked);

  const shifted = sessions.map((s) => ({
    ...s,
    startTime: shiftInstantByCalendarDays(s.startTime, dayDelta, timeZone),
    endTime: shiftInstantByCalendarDays(s.endTime, dayDelta, timeZone),
  }));
  for (const s of shifted) {
    await tx.eventSession.update({
      where: { id: s.id, eventId },
      data: { startTime: s.startTime, endTime: s.endTime },
    });
  }

  // 3 + 4. Sales windows on tiers AND ticket types, same rule, closing dates
  // never into the past.
  const sameInstant = (a: Date | null, b: Date | null) =>
    (a?.getTime() ?? null) === (b?.getTime() ?? null);
  const shiftWindow = (w: { salesStart: Date | null; salesEnd: Date | null }) => {
    const salesStart = shiftDateUnderRule(w.salesStart, dayDelta, timeZone, now);
    const end = shiftClosingDateUnderRule(w.salesEnd, dayDelta, timeZone, now);
    if (end.keptOpen) keptOpen += 1;
    const changed = !sameInstant(salesStart, w.salesStart) || !sameInstant(end.value, w.salesEnd);
    return { changed, data: { salesStart, salesEnd: end.value } };
  };

  const tiers = await tx.pricingTier.findMany({
    where: { ticketType: { eventId } },
    select: WINDOW_SELECT,
  });
  let tiersMoved = 0;
  for (const t of tiers) {
    const w = shiftWindow(t);
    if (!w.changed) continue;
    await tx.pricingTier.update({ where: { id: t.id }, data: w.data });
    tiersMoved += 1;
  }

  const ticketTypes = await tx.ticketType.findMany({ where: { eventId }, select: WINDOW_SELECT });
  let ticketTypesMoved = 0;
  for (const t of ticketTypes) {
    const w = shiftWindow(t);
    if (!w.changed) continue;
    await tx.ticketType.update({ where: { id: t.id }, data: w.data });
    ticketTypesMoved += 1;
  }

  // The two submission deadlines, closing dates, skipping any the request set.
  // The Event row is already locked by the caller's dates update, so this
  // read-modify-write cannot be interleaved by another settings writer.
  const row = await tx.event.findUnique({ where: { id: eventId }, select: { settings: true } });
  const settings =
    row?.settings && typeof row.settings === "object" && !Array.isArray(row.settings)
      ? { ...(row.settings as Record<string, unknown>) }
      : {};
  const deadlinesMoved: DeadlineKey[] = [];
  const shiftDeadline = (key: DeadlineKey, read: (s: unknown) => string | null, skip: boolean) => {
    if (skip) return;
    const current = read(settings);
    if (!current) return;
    const r = shiftClosingDateUnderRule(new Date(current), dayDelta, timeZone, now);
    if (r.keptOpen) keptOpen += 1;
    if (!r.value || r.value.getTime() === new Date(current).getTime()) return;
    settings[key] = r.value.toISOString();
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
    ticketTypesMoved,
    deadlinesMoved,
    keptOpen,
    zoomSessions: zoomSessions.length,
  });

  return {
    dayDelta,
    sessionsMoved: shifted.length,
    tiersMoved,
    ticketTypesMoved,
    deadlinesMoved,
    keptOpen,
    zoomSessions,
  };
}
