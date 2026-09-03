/**
 * Event postponement shift (Sep 2, 2026). The service moves every session by
 * N calendar days inside the caller's transaction and applies ONE rule to
 * tier windows and deadlines: dates in the future move, dates in the past
 * stay. The two guards that matter are pinned here because each fails
 * silently in production: a shift that leaves a session outside the window
 * must roll back (else the orphan state the M9 guard exists to prevent), and
 * a past sales window must not reopen (else an Early Bird discount is handed
 * back to everyone who already paid Standard).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  applyScheduleShift,
  shiftDateUnderRule,
  ScheduleShiftBlockedError,
} from "@/services/event-schedule-shift";

const TZ = "Asia/Dubai";
const NOW = new Date("2026-09-20T08:00:00Z");

describe("shiftDateUnderRule", () => {
  it("null stays null", () => {
    expect(shiftDateUnderRule(null, 21, TZ, NOW)).toBeNull();
  });
  it("a PAST date is returned unchanged (same instance)", () => {
    const past = new Date("2026-09-15T20:00:00Z");
    expect(shiftDateUnderRule(past, 21, TZ, NOW)).toBe(past);
  });
  it("a date exactly at now is treated as past", () => {
    expect(shiftDateUnderRule(NOW, 21, TZ, NOW)).toBe(NOW);
  });
  it("a FUTURE date moves by the day delta, wall-clock kept", () => {
    const future = new Date("2026-10-10T19:59:00Z"); // 23:59 Dubai
    expect(shiftDateUnderRule(future, 21, TZ, NOW)?.toISOString()).toBe("2026-10-31T19:59:00.000Z");
  });
});

// ── applyScheduleShift against a fake transaction client ───────────────────

function fakeTx(seed: {
  sessions?: Array<Record<string, unknown>>;
  tiers?: Array<Record<string, unknown>>;
  settings?: Record<string, unknown>;
}) {
  return {
    eventSession: {
      findMany: vi.fn().mockResolvedValue(seed.sessions ?? []),
      update: vi.fn().mockResolvedValue({}),
    },
    pricingTier: {
      findMany: vi.fn().mockResolvedValue(seed.tiers ?? []),
      update: vi.fn().mockResolvedValue({}),
    },
    event: {
      findUnique: vi.fn().mockResolvedValue({ settings: seed.settings ?? {} }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

// Event: Oct 15–17 (Dubai) → Nov 5–7, i.e. +21 days.
const base = {
  eventId: "ev-1",
  dayDelta: 21,
  timeZone: TZ,
  newStart: new Date("2026-11-05T05:00:00Z"),
  newEnd: new Date("2026-11-07T14:00:00Z"),
  now: NOW,
  explicitlyChangedDeadlines: { abstract: false, sessionProposal: false },
};

const session = (id: string, startZ: string, endZ: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Session ${id}`,
  startTime: new Date(startZ),
  endTime: new Date(endZ),
  status: "SCHEDULED",
  zoomMeeting: null,
  ...extra,
});

beforeEach(() => vi.clearAllMocks());

describe("applyScheduleShift: sessions", () => {
  it("moves EVERY session by the day delta, cancelled and break items included, bound to the event", async () => {
    const tx = fakeTx({
      sessions: [
        session("a", "2026-10-15T05:00:00Z", "2026-10-15T06:00:00Z"), // 09:00 day 1
        session("b", "2026-10-16T12:00:00Z", "2026-10-16T13:00:00Z", { status: "CANCELLED" }),
        session("c", "2026-10-17T06:30:00Z", "2026-10-17T07:00:00Z", { type: "BREAK" }),
      ],
    });
    const out = await applyScheduleShift(tx as never, base);
    expect(out.sessionsMoved).toBe(3);
    expect(tx.eventSession.update).toHaveBeenCalledTimes(3);
    expect(tx.eventSession.update).toHaveBeenCalledWith({
      where: { id: "a", eventId: "ev-1" },
      data: { startTime: new Date("2026-11-05T05:00:00Z"), endTime: new Date("2026-11-05T06:00:00Z") },
    });
    // The cancelled one moves too, so it lands on the right day if un-cancelled.
    expect(tx.eventSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b", eventId: "ev-1" } }),
    );
  });

  it("rolls back with the offending sessions at their SHIFTED times when one still lands outside", async () => {
    // A day-3 session on an event that also got SHORTER (new window is 2 days).
    const tx = fakeTx({
      sessions: [
        session("a", "2026-10-15T05:00:00Z", "2026-10-15T06:00:00Z"),
        session("late", "2026-10-17T06:00:00Z", "2026-10-17T07:00:00Z"),
      ],
    });
    const shorter = { ...base, newEnd: new Date("2026-11-06T14:00:00Z") };
    await expect(applyScheduleShift(tx as never, shorter)).rejects.toBeInstanceOf(ScheduleShiftBlockedError);
    try {
      await applyScheduleShift(tx as never, shorter);
    } catch (err) {
      const e = err as ScheduleShiftBlockedError;
      expect(e.sessions).toHaveLength(1);
      expect(e.sessions[0].id).toBe("late");
      // Named where it WOULD land (Nov 7), not where it is (Oct 17).
      expect(e.sessions[0].startTime.toISOString()).toBe("2026-11-07T06:00:00.000Z");
    }
    // Nothing was written: the guard runs before any update.
    expect(tx.eventSession.update).not.toHaveBeenCalled();
    expect(tx.pricingTier.update).not.toHaveBeenCalled();
    expect(tx.event.update).not.toHaveBeenCalled();
  });

  it("a CANCELLED session outside the new window does not block (it no longer renders)", async () => {
    const tx = fakeTx({
      sessions: [session("gone", "2026-10-17T06:00:00Z", "2026-10-17T07:00:00Z", { status: "CANCELLED" })],
    });
    const shorter = { ...base, newEnd: new Date("2026-11-06T14:00:00Z") };
    await expect(applyScheduleShift(tx as never, shorter)).resolves.toMatchObject({ sessionsMoved: 1 });
  });

  it("returns the shifted times of sessions that carry a Zoom meeting, for the post-commit re-sync", async () => {
    const zm = { id: "zm1", zoomMeetingId: "999", meetingType: "MEETING" };
    const tx = fakeTx({
      sessions: [
        session("a", "2026-10-15T05:00:00Z", "2026-10-15T06:00:00Z", { zoomMeeting: zm }),
        session("b", "2026-10-15T07:00:00Z", "2026-10-15T08:00:00Z"),
      ],
    });
    const out = await applyScheduleShift(tx as never, base);
    expect(out.zoomSessions).toEqual([
      {
        sessionId: "a",
        zoomMeeting: zm,
        startTime: new Date("2026-11-05T05:00:00Z"),
        endTime: new Date("2026-11-05T06:00:00Z"),
      },
    ]);
  });
});

describe("applyScheduleShift: tier sales windows (future moves, past stays)", () => {
  it("an already-closed Early Bird is NOT reopened; an open Standard keeps its start and moves its end; a future Onsite moves both", async () => {
    const tx = fakeTx({
      tiers: [
        // Early Bird: Aug 1 → Sep 15, both past.
        { id: "eb", salesStart: new Date("2026-08-01T00:00:00Z"), salesEnd: new Date("2026-09-15T19:59:00Z") },
        // Standard: opened Sep 16 (past), closes Oct 10 (future).
        { id: "std", salesStart: new Date("2026-09-16T00:00:00Z"), salesEnd: new Date("2026-10-10T19:59:00Z") },
        // Onsite: Oct 11 → Oct 15, both future.
        { id: "on", salesStart: new Date("2026-10-11T00:00:00Z"), salesEnd: new Date("2026-10-15T19:59:00Z") },
        // No window at all.
        { id: "open", salesStart: null, salesEnd: null },
      ],
    });
    const out = await applyScheduleShift(tx as never, base);
    expect(out.tiersMoved).toBe(2);
    expect(tx.pricingTier.update).toHaveBeenCalledTimes(2);
    expect(tx.pricingTier.update).toHaveBeenCalledWith({
      where: { id: "std" },
      data: {
        salesStart: new Date("2026-09-16T00:00:00Z"), // unchanged: it is open today
        salesEnd: new Date("2026-10-31T19:59:00Z"), // +21 days
      },
    });
    expect(tx.pricingTier.update).toHaveBeenCalledWith({
      where: { id: "on" },
      data: {
        salesStart: new Date("2026-11-01T00:00:00Z"),
        salesEnd: new Date("2026-11-05T19:59:00Z"),
      },
    });
    const touched = tx.pricingTier.update.mock.calls.map((c) => c[0].where.id);
    expect(touched).not.toContain("eb");
    expect(touched).not.toContain("open");
  });
});

describe("applyScheduleShift: submission deadlines", () => {
  it("shifts a FUTURE deadline the request merely echoed, and writes settings once", async () => {
    const tx = fakeTx({
      settings: {
        abstractDeadline: "2026-10-01T19:59:00.000Z",
        sessionProposalDeadline: "2026-09-01T19:59:00.000Z", // past: stays
        unrelated: "kept",
      },
    });
    const out = await applyScheduleShift(tx as never, base);
    expect(out.deadlinesMoved).toEqual(["abstractDeadline"]);
    expect(tx.event.update).toHaveBeenCalledTimes(1);
    expect(tx.event.update).toHaveBeenCalledWith({
      where: { id: "ev-1" },
      data: {
        settings: {
          abstractDeadline: "2026-10-22T19:59:00.000Z",
          sessionProposalDeadline: "2026-09-01T19:59:00.000Z",
          unrelated: "kept",
        },
      },
    });
  });

  it("leaves a deadline the organiser changed in THIS request alone", async () => {
    const tx = fakeTx({ settings: { abstractDeadline: "2026-10-01T19:59:00.000Z" } });
    const out = await applyScheduleShift(tx as never, {
      ...base,
      explicitlyChangedDeadlines: { abstract: true, sessionProposal: false },
    });
    expect(out.deadlinesMoved).toEqual([]);
    expect(tx.event.update).not.toHaveBeenCalled();
  });

  it("writes nothing when no deadline is set", async () => {
    const tx = fakeTx({ settings: {} });
    const out = await applyScheduleShift(tx as never, base);
    expect(out.deadlinesMoved).toEqual([]);
    expect(tx.event.update).not.toHaveBeenCalled();
  });
});
