/**
 * Webinar email-sequence RESCHEDULE (Aug 4, 2026 — organizer-reported: after
 * retiming a webinar, the reminder/live-now emails kept firing on the ORIGINAL
 * schedule because the ScheduledEmail rows' fire times were computed once at
 * provisioning and nothing ever moved them).
 *
 * Pins:
 *  - the non-force idempotency guard is unchanged (any webinar-* row ⇒ skip)
 *  - force mode skips that guard but NEVER re-creates a phase that already
 *    SENT/PROCESSING (no double reminder emails)
 *  - rescheduleWebinarSequenceForEvent = clear pending + force re-enqueue at
 *    the anchor session's CURRENT times
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, mockApiLogger, locked } = vi.hoisted(() => ({
  // What the settings row lock reads: the row as it is when the lock is taken.
  locked: { settings: { webinar: { sessionId: "anchor1" } } as Record<string, unknown> },
  mockDb: {
    event: { findUnique: vi.fn(), update: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    scheduledEmail: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    user: { findFirst: vi.fn() },
  },
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: mockDb,
  // reschedule runs clear+create inside one tenantTransaction holding a
  // per-event advisory xact lock — passthrough with a $queryRaw stub.
  // The raw reads are the advisory lock (its answer unused) and the settings row lock, which
  // answers the webinar's settings.
  tenantTransaction: (fn: (tx: unknown) => unknown) =>
    fn({ ...mockDb, $queryRaw: vi.fn().mockImplementation(async () => [{ settings: locked.settings }]) }),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import {
  enqueueWebinarSequenceForEvent,
  isSequenceRowForOtherDate,
  rescheduleWebinarSequenceForEvent,
  THANK_YOU_AFTER_CLOSE_MS,
} from "@/lib/webinar-email-sequence";

const NOW = new Date("2026-09-01T00:00:00Z");
// New webinar window: start in 3 days → all 5 phases are in the future.
const START = new Date("2026-09-04T10:00:00Z");
const END = new Date("2026-09-04T11:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  locked.settings = { webinar: { sessionId: "anchor1" } };
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // A webinar whose organiser scheduled the usual five (Nov 25, 2026: nothing is queued before that).
  mockDb.event.findUnique.mockResolvedValue({
    id: "ev1",
    organizationId: "org1",
    settings: { webinar: { sessionId: "anchor1", sequence: { confirmed: true } } },
  });
  mockDb.eventSession.findFirst.mockResolvedValue({ startTime: START, endTime: END });
  mockDb.scheduledEmail.findFirst.mockResolvedValue(null);
  mockDb.scheduledEmail.findMany.mockResolvedValue([]);
  mockDb.scheduledEmail.createMany.mockResolvedValue({ count: 4 });
  mockDb.scheduledEmail.deleteMany.mockResolvedValue({ count: 4 });
  mockDb.user.findFirst.mockResolvedValue({ id: "admin1" });
});

afterEach(() => {
  vi.useRealTimers();
});

function createdPhases(): string[] {
  const call = mockDb.scheduledEmail.createMany.mock.calls[0]?.[0] as
    | { data: Array<{ emailType: string; scheduledFor: Date }> }
    | undefined;
  return call?.data.map((d) => d.emailType) ?? [];
}

describe("enqueueWebinarSequenceForEvent — force mode", () => {
  it("non-force: ANY existing webinar-* row still short-circuits (unchanged contract)", async () => {
    mockDb.scheduledEmail.findFirst.mockResolvedValue({ id: "row1" });
    const res = await enqueueWebinarSequenceForEvent("ev1", "u1");
    expect(res.skipped).toBe("already-enqueued");
    expect(mockDb.scheduledEmail.createMany).not.toHaveBeenCalled();
  });

  it("force: skips the guard and creates all 5 future phases at the anchor's times", async () => {
    mockDb.scheduledEmail.findFirst.mockResolvedValue({ id: "stale-row" }); // would block non-force
    const res = await enqueueWebinarSequenceForEvent("ev1", "u1", { force: true });
    expect(res.created).toBe(5);
    expect(createdPhases()).toEqual([
      "webinar-reminder-24h",
      "webinar-reminder-1h",
      "webinar-reminder-15m",
      "webinar-live-now",
      "webinar-thank-you",
    ]);
    const rows = (mockDb.scheduledEmail.createMany.mock.calls[0][0] as {
      data: Array<{ emailType: string; scheduledFor: Date }>;
    }).data;
    const byType = Object.fromEntries(rows.map((r) => [r.emailType, r.scheduledFor.getTime()]));
    expect(byType["webinar-reminder-24h"]).toBe(START.getTime() - 24 * 3600_000);
    expect(byType["webinar-reminder-1h"]).toBe(START.getTime() - 3600_000);
    expect(byType["webinar-reminder-15m"]).toBe(START.getTime() - 15 * 60_000);
    expect(byType["webinar-live-now"]).toBe(START.getTime());
    expect(byType["webinar-thank-you"]).toBe(END.getTime() + THANK_YOU_AFTER_CLOSE_MS);
  });

  it("force: a phase that already SENT is NEVER re-created (no duplicate reminder)", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-reminder-24h", status: "SENT", emailedKeys: [], scheduledFor: new Date("2026-09-03T10:00:00Z") }, // fired for this date
    ]);
    const res = await enqueueWebinarSequenceForEvent("ev1", "u1", { force: true });
    expect(res.created).toBe(4);
    expect(createdPhases()).not.toContain("webinar-reminder-24h");
    expect(createdPhases()).toContain("webinar-live-now");
    // The SENT-exclusion query filters on SENT/PROCESSING only — pending rows
    // are the caller's (clear step's) responsibility.
    expect(mockDb.scheduledEmail.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["SENT", "PROCESSING", "CANCELLED", "FAILED"] },
        }),
      }),
    );
  });

  it("force: past phases are still dropped (webinar moved EARLIER)", async () => {
    // Webinar starts in 30 minutes → 24h + 1h reminders are in the past; the 15-minute one is not.
    mockDb.eventSession.findFirst.mockResolvedValue({
      startTime: new Date(NOW.getTime() + 30 * 60_000),
      endTime: new Date(NOW.getTime() + 90 * 60_000),
    });
    const res = await enqueueWebinarSequenceForEvent("ev1", "u1", { force: true });
    expect(res.created).toBe(3);
    expect(createdPhases()).toEqual(["webinar-reminder-15m", "webinar-live-now", "webinar-thank-you"]);
  });
});

describe("rescheduleWebinarSequenceForEvent", () => {
  it("clears pending rows then force re-enqueues at the CURRENT anchor times", async () => {
    mockDb.scheduledEmail.deleteMany.mockResolvedValue({ count: 3 });
    const res = await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(res.cleared).toBe(3);
    expect(res.created).toBe(5);
    // Clear touches ONLY re-creatable auto-sequence rows (M1/M2/M3): the 5
    // phases (never webinar-confirmation), never manually-composed rows,
    // PENDING + fully-unsent FAILED; CANCELLED stays unless resurrecting.
    expect(mockDb.scheduledEmail.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          eventId: "ev1",
          emailType: {
            in: ["webinar-reminder-24h", "webinar-reminder-1h", "webinar-reminder-15m", "webinar-live-now", "webinar-thank-you"],
          },
          customSubject: null,
          customMessage: null,
          recipientIds: { isEmpty: true },
          OR: [
            { status: "PENDING" },
            { status: "FAILED", emailedKeys: { isEmpty: true } },
          ],
        }),
      }),
    );
    // The delete ran BEFORE the create (clear-then-enqueue ordering).
    const deleteOrder = mockDb.scheduledEmail.deleteMany.mock.invocationCallOrder[0];
    const createOrder = mockDb.scheduledEmail.createMany.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(createOrder);
  });

  it("a SENT live-now survives a reschedule while the rest move (console Re-enqueue bug)", async () => {
    // Before force mode, one SENT row made the plain clear+enqueue pair skip
    // EVERYTHING ("already-enqueued") — the console button silently did nothing.
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-live-now", status: "SENT", emailedKeys: [], scheduledFor: new Date("2026-09-04T10:00:00Z") },
    ]);
    const res = await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(res.created).toBe(4);
    expect(createdPhases()).toEqual([
      "webinar-reminder-24h",
      "webinar-reminder-1h",
      "webinar-reminder-15m",
      "webinar-thank-you",
    ]);
  });
});

describe("reschedule semantics — cancelled / partial-failed phases (review M1/M2)", () => {
  it("an operator-CANCELLED phase is NOT resurrected by an automatic reschedule", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-live-now", status: "CANCELLED", emailedKeys: [], scheduledFor: new Date("2026-09-04T10:00:00Z") },
    ]);
    const res = await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(res.created).toBe(4);
    expect(createdPhases()).not.toContain("webinar-live-now");
    // The clear must not delete the CANCELLED row either (no OR branch for it).
    const where = (mockDb.scheduledEmail.deleteMany.mock.calls[0][0] as {
      where: { OR: Array<{ status: string }> };
    }).where;
    expect(where.OR.map((o) => o.status)).toEqual(["PENDING", "FAILED"]);
  });

  it("an explicit save re-creates a cancelled phase it names (revivePhases), and only that one", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-live-now", status: "CANCELLED", emailedKeys: [], scheduledFor: new Date("2026-09-04T10:00:00Z") },
      { emailType: "webinar-reminder-15m", status: "CANCELLED", emailedKeys: [], scheduledFor: new Date("2026-09-04T09:45:00Z") },
    ]);
    const res = await rescheduleWebinarSequenceForEvent("ev1", "u1", { revivePhases: ["webinar-live-now"] });
    expect(res.created).toBe(4);
    expect(createdPhases()).toContain("webinar-live-now");
    expect(createdPhases()).not.toContain("webinar-reminder-15m");
    const where = (mockDb.scheduledEmail.deleteMany.mock.calls[0][0] as {
      where: { OR: Array<{ status: string; emailType?: unknown }> };
    }).where;
    expect(where.OR.map((o) => o.status)).toEqual(["PENDING", "FAILED", "CANCELLED"]);
    // The clear deletes only the named phase's cancelled row.
    expect(where.OR[2].emailType).toEqual({ in: ["webinar-live-now"] });
  });

  it("a save that names nothing (a time changed) brings back no cancelled phase (review of 3e967af29)", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-live-now", status: "CANCELLED", emailedKeys: [], scheduledFor: new Date("2026-09-04T10:00:00Z") },
    ]);
    await rescheduleWebinarSequenceForEvent("ev1", "u1", { revivePhases: [] });
    expect(createdPhases()).not.toContain("webinar-live-now");
  });

  it("a FAILED phase with partial deliveries keeps its resume state and is not re-created", async () => {
    // 500 of 2000 delivered → emailedKeys non-empty. Re-creating would email
    // the 500 again; the row survives for the operator's Retry instead.
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-reminder-24h", status: "FAILED", emailedKeys: ["r1", "r2"], scheduledFor: new Date("2026-09-03T10:00:00Z") },
    ]);
    const res = await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(res.created).toBe(4);
    expect(createdPhases()).not.toContain("webinar-reminder-24h");
  });
});

describe("postponement: a phase sent for the OLD date is sent again for the new one (Oct 28, 2026)", () => {
  // The anchor now starts 2026-09-04T10:00Z; these rows went out for a webinar once set for 2026-08-20.
  const OLD = (iso: string) => new Date(iso);

  it("every phase that fired for a date more than 12 hours away is queued again", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-reminder-24h", status: "SENT", emailedKeys: [], scheduledFor: OLD("2026-08-19T10:00:00Z") },
      { emailType: "webinar-reminder-1h", status: "SENT", emailedKeys: [], scheduledFor: OLD("2026-08-20T09:00:00Z") },
      { emailType: "webinar-reminder-15m", status: "SENT", emailedKeys: [], scheduledFor: OLD("2026-08-20T09:45:00Z") },
      { emailType: "webinar-live-now", status: "SENT", emailedKeys: [], scheduledFor: OLD("2026-08-20T10:00:00Z") },
      { emailType: "webinar-thank-you", status: "SENT", emailedKeys: [], scheduledFor: OLD("2026-08-20T11:30:00Z") },
    ]);
    const res = await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(res.created).toBe(5);
    expect(createdPhases()).toEqual(["webinar-reminder-24h", "webinar-reminder-1h", "webinar-reminder-15m", "webinar-live-now", "webinar-thank-you"]);
  });

  it("a move of an hour does not double-send: the organiser emails by hand", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      // sent for 09:00, the webinar now starts 10:00
      { emailType: "webinar-reminder-1h", status: "SENT", emailedKeys: [], scheduledFor: OLD("2026-09-04T08:00:00Z") },
    ]);
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(createdPhases()).not.toContain("webinar-reminder-1h");
  });

  it("exactly 12 hours still counts as the same date; just over it does not", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-live-now", status: "SENT", emailedKeys: [], scheduledFor: OLD("2026-09-03T22:00:00Z") },
      { emailType: "webinar-thank-you", status: "SENT", emailedKeys: [], scheduledFor: OLD("2026-09-03T23:29:00Z") },
    ]);
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(createdPhases()).not.toContain("webinar-live-now");
    expect(createdPhases()).toContain("webinar-thank-you");
  });

  it("a cancel or a partial failure on the old date does not block the new date either", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-live-now", status: "CANCELLED", emailedKeys: [], scheduledFor: OLD("2026-08-20T10:00:00Z") },
      { emailType: "webinar-reminder-24h", status: "FAILED", emailedKeys: ["r1"], scheduledFor: OLD("2026-08-19T10:00:00Z") },
    ]);
    const res = await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(res.created).toBe(5);
  });
});

describe("which date a row was for: the stamped webinar start, not its send time (review MED, Oct 28, 2026)", () => {
  const current = { startTime: START, endTime: END };

  it("new rows record the webinar start they were made for", async () => {
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    const data = (mockDb.scheduledEmail.createMany.mock.calls[0][0] as { data: Array<{ filters: unknown }> }).data;
    for (const row of data) expect(row.filters).toEqual({ status: "CONFIRMED", webinarStartsAt: START.toISOString() });
  });

  it("an organiser moving a sent row's time does not make it look like another date (no double send)", async () => {
    // The 24h reminder was dragged to 3 days before and went out; the webinar has not moved.
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-reminder-24h", status: "SENT", emailedKeys: [], scheduledFor: new Date("2026-09-01T10:00:00Z"), filters: { status: "CONFIRMED", webinarStartsAt: START.toISOString() } },
    ]);
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(createdPhases()).not.toContain("webinar-reminder-24h");
  });

  it("a late retry of an old-date row does not hide the new date's phase (no lost reminder)", async () => {
    // Made for a webinar starting 13h earlier, retried late so its send time sits near the new one.
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-reminder-24h", status: "FAILED", emailedKeys: ["r1"], scheduledFor: new Date("2026-09-03T09:00:00Z"), filters: { status: "CONFIRMED", webinarStartsAt: "2026-09-03T21:00:00.000Z" } },
    ]);
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(createdPhases()).toContain("webinar-reminder-24h");
  });

  it("rows from before the stamp are read back through the phase offset", () => {
    const legacy = (emailType: string, at: string) => ({ emailType, scheduledFor: new Date(at), filters: { status: "CONFIRMED" } });
    expect(isSequenceRowForOtherDate(legacy("webinar-reminder-1h", "2026-09-04T09:00:00Z"), current)).toBe(false);
    expect(isSequenceRowForOtherDate(legacy("webinar-reminder-15m", "2026-09-04T09:45:00Z"), current)).toBe(false);
    expect(isSequenceRowForOtherDate(legacy("webinar-reminder-15m", "2026-08-20T09:45:00Z"), current)).toBe(true);
    // A legacy thank-you was made at end + 30, the delay before the stamp; it still reads as this date.
    expect(isSequenceRowForOtherDate(legacy("webinar-thank-you", "2026-09-04T11:30:00Z"), current)).toBe(false);
    expect(isSequenceRowForOtherDate(legacy("webinar-live-now", "2026-08-20T10:00:00Z"), current)).toBe(true);
    expect(isSequenceRowForOtherDate(legacy("webinar-confirmation", "2026-08-20T10:00:00Z"), current)).toBe(false);
  });
});

describe("a rebuild after the webinar has run keeps the thank-you (review MED, Oct 28, 2026)", () => {
  const thankYouAt = () => {
    const rows = (mockDb.scheduledEmail.createMany.mock.calls[0]?.[0] as { data: Array<{ emailType: string; scheduledFor: Date }> } | undefined)?.data ?? [];
    return rows.find((r) => r.emailType === "webinar-thank-you")?.scheduledFor;
  };

  it("an overrunning webinar, room still open past the end: the thank-you is re-created 5 minutes from now", async () => {
    vi.setSystemTime(new Date("2026-09-04T11:45:00Z"));
    mockDb.eventSession.findFirst.mockResolvedValue({ startTime: START, endTime: END, status: "LIVE" });
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(thankYouAt()).toEqual(new Date("2026-09-04T11:50:00Z"));
  });

  it("closed after an overrun: a Re-enqueue does not lose it", async () => {
    vi.setSystemTime(new Date("2026-09-04T11:45:00Z"));
    mockDb.eventSession.findFirst.mockResolvedValue({ startTime: START, endTime: END, status: "COMPLETED" });
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(thankYouAt()).toEqual(new Date("2026-09-04T11:50:00Z"));
  });

  it("closed early: a Re-enqueue keeps it early rather than putting it back to end + 5", async () => {
    vi.setSystemTime(new Date("2026-09-04T10:40:00Z"));
    mockDb.eventSession.findFirst.mockResolvedValue({ startTime: START, endTime: END, status: "COMPLETED" });
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(thankYouAt()).toEqual(new Date("2026-09-04T10:45:00Z"));
  });

  it("before it runs, nothing changes: end + 5 (owner, Nov 25, 2026; it was 30)", async () => {
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(thankYouAt()).toEqual(new Date("2026-09-04T11:05:00Z"));
  });
});

// Owner, Nov 25, 2026: "make it manual, let the organiser decide what is the sequence".
describe("the organiser's plan", () => {
  const settings = (sequence?: unknown) => ({ id: "ev1", organizationId: "org1", settings: { webinar: { sessionId: "anchor1", ...(sequence === undefined ? {} : { sequence }) } } });

  it("a new webinar (no plan, no rows) queues nothing: the provisioner's call and a date move both wait", async () => {
    mockDb.event.findUnique.mockResolvedValue(settings());
    expect((await enqueueWebinarSequenceForEvent("ev1", "u1")).skipped).toBe("not-scheduled");
    const moved = await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(moved).toMatchObject({ skipped: "not-scheduled", cleared: 0 });
    expect(mockDb.scheduledEmail.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.scheduledEmail.createMany).not.toHaveBeenCalled();
  });

  it("a plan saved but not confirmed (a clone) queues nothing either", async () => {
    mockDb.event.findUnique.mockResolvedValue(settings({ confirmed: false }));
    expect((await rescheduleWebinarSequenceForEvent("ev1", "u1")).skipped).toBe("not-scheduled");
    expect(mockDb.scheduledEmail.createMany).not.toHaveBeenCalled();
  });

  it("a webinar from before the change (no plan, rows queued) keeps rescheduling as it did", async () => {
    mockDb.event.findUnique.mockResolvedValue(settings());
    mockDb.scheduledEmail.findFirst.mockResolvedValue({ id: "old-row" });
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(createdPhases()).toHaveLength(5);
  });

  it("an older webinar gets its plan written down before the clear, so losing every row cannot unschedule it (review of 3e967af29)", async () => {
    mockDb.event.findUnique.mockResolvedValue(settings());
    mockDb.scheduledEmail.findFirst.mockResolvedValue({ id: "old-row" });
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    const written = mockDb.event.update.mock.calls[0][0] as { data: { settings: { webinar: { sessionId: string; sequence: { confirmed: boolean; phases: Record<string, { enabled: boolean }> } } } } };
    expect(written.data.settings.webinar.sessionId).toBe("anchor1");
    expect(written.data.settings.webinar.sequence.confirmed).toBe(true);
    expect(Object.values(written.data.settings.webinar.sequence.phases).every((p) => p.enabled)).toBe(true);
    // Written before the clear.
    expect(mockDb.event.update.mock.invocationCallOrder[0]).toBeLessThan(mockDb.scheduledEmail.deleteMany.mock.invocationCallOrder[0]);
  });

  it("a plan the organiser saved between the read and the lock is never replaced by the usual five (review, Nov 25, 2026)", async () => {
    mockDb.event.findUnique.mockResolvedValue(settings());
    mockDb.scheduledEmail.findFirst.mockResolvedValue({ id: "old-row" });
    const saved = { confirmed: true, phases: { "webinar-reminder-1h": { enabled: false, minutes: 60 } } };
    locked.settings = { webinar: { sessionId: "anchor1", sequence: saved } };
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    const written = mockDb.event.update.mock.calls[0][0] as { data: { settings: { webinar: { sequence: unknown } } } };
    expect(written.data.settings.webinar.sequence).toEqual(saved);
  });

  it("a stored plan is never rewritten by a reschedule", async () => {
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(mockDb.event.update).not.toHaveBeenCalled();
  });

  it("a hand-composed reminder does not make a webinar read as scheduled (review of 3e967af29)", async () => {
    mockDb.event.findUnique.mockResolvedValue(settings());
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    const where = mockDb.scheduledEmail.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ customSubject: null, customMessage: null, recipientIds: { isEmpty: true } });
  });

  it("a switched-off email is never created, and each kept one goes at the organiser's time", async () => {
    mockDb.event.findUnique.mockResolvedValue(
      settings({
        confirmed: true,
        phases: {
          "webinar-reminder-24h": { enabled: true, minutes: 2 * 24 * 60 },
          "webinar-reminder-1h": { enabled: false, minutes: 60 },
          "webinar-reminder-15m": { enabled: true, minutes: 30 },
          "webinar-live-now": { enabled: true, minutes: 5 },
          "webinar-thank-you": { enabled: true, minutes: 20 },
        },
      }),
    );
    await rescheduleWebinarSequenceForEvent("ev1", "u1");
    const rows = (mockDb.scheduledEmail.createMany.mock.calls[0][0] as { data: Array<{ emailType: string; scheduledFor: Date }> }).data;
    const at = Object.fromEntries(rows.map((r) => [r.emailType, r.scheduledFor.toISOString()]));
    expect(Object.keys(at)).not.toContain("webinar-reminder-1h");
    expect(at["webinar-reminder-24h"]).toBe("2026-09-02T10:00:00.000Z");
    expect(at["webinar-reminder-15m"]).toBe("2026-09-04T09:30:00.000Z");
    expect(at["webinar-live-now"]).toBe("2026-09-04T10:05:00.000Z");
    expect(at["webinar-thank-you"]).toBe("2026-09-04T11:20:00.000Z");
  });
});
