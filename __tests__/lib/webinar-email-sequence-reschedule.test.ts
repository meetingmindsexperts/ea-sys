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

const { mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockDb: {
    event: { findUnique: vi.fn() },
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
  tenantTransaction: (fn: (tx: unknown) => unknown) =>
    fn({ ...mockDb, $queryRaw: vi.fn().mockResolvedValue([]) }),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import {
  enqueueWebinarSequenceForEvent,
  rescheduleWebinarSequenceForEvent,
} from "@/lib/webinar-email-sequence";

const NOW = new Date("2026-09-01T00:00:00Z");
// New webinar window: start in 3 days → all 4 phases are in the future.
const START = new Date("2026-09-04T10:00:00Z");
const END = new Date("2026-09-04T11:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockDb.event.findUnique.mockResolvedValue({
    id: "ev1",
    organizationId: "org1",
    settings: { webinar: { sessionId: "anchor1" } },
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

  it("force: skips the guard and creates all 4 future phases at the anchor's times", async () => {
    mockDb.scheduledEmail.findFirst.mockResolvedValue({ id: "stale-row" }); // would block non-force
    const res = await enqueueWebinarSequenceForEvent("ev1", "u1", { force: true });
    expect(res.created).toBe(4);
    expect(createdPhases()).toEqual([
      "webinar-reminder-24h",
      "webinar-reminder-1h",
      "webinar-live-now",
      "webinar-thank-you",
    ]);
    const rows = (mockDb.scheduledEmail.createMany.mock.calls[0][0] as {
      data: Array<{ emailType: string; scheduledFor: Date }>;
    }).data;
    const byType = Object.fromEntries(rows.map((r) => [r.emailType, r.scheduledFor.getTime()]));
    expect(byType["webinar-reminder-24h"]).toBe(START.getTime() - 24 * 3600_000);
    expect(byType["webinar-reminder-1h"]).toBe(START.getTime() - 3600_000);
    expect(byType["webinar-live-now"]).toBe(START.getTime());
    expect(byType["webinar-thank-you"]).toBe(END.getTime() + 30 * 60_000);
  });

  it("force: a phase that already SENT is NEVER re-created (no duplicate reminder)", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-reminder-24h", status: "SENT", emailedKeys: [] }, // fired at the old time
    ]);
    const res = await enqueueWebinarSequenceForEvent("ev1", "u1", { force: true });
    expect(res.created).toBe(3);
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
    // Webinar starts in 30 minutes → 24h + 1h reminders are in the past.
    mockDb.eventSession.findFirst.mockResolvedValue({
      startTime: new Date(NOW.getTime() + 30 * 60_000),
      endTime: new Date(NOW.getTime() + 90 * 60_000),
    });
    const res = await enqueueWebinarSequenceForEvent("ev1", "u1", { force: true });
    expect(res.created).toBe(2);
    expect(createdPhases()).toEqual(["webinar-live-now", "webinar-thank-you"]);
  });
});

describe("rescheduleWebinarSequenceForEvent", () => {
  it("clears pending rows then force re-enqueues at the CURRENT anchor times", async () => {
    mockDb.scheduledEmail.deleteMany.mockResolvedValue({ count: 3 });
    const res = await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(res.cleared).toBe(3);
    expect(res.created).toBe(4);
    // Clear touches ONLY re-creatable auto-sequence rows (M1/M2/M3): the 4
    // phases (never webinar-confirmation), never manually-composed rows,
    // PENDING + fully-unsent FAILED; CANCELLED stays unless resurrecting.
    expect(mockDb.scheduledEmail.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          eventId: "ev1",
          emailType: {
            in: ["webinar-reminder-24h", "webinar-reminder-1h", "webinar-live-now", "webinar-thank-you"],
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
      { emailType: "webinar-live-now", status: "SENT", emailedKeys: [] },
    ]);
    const res = await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(res.created).toBe(3);
    expect(createdPhases()).toEqual([
      "webinar-reminder-24h",
      "webinar-reminder-1h",
      "webinar-thank-you",
    ]);
  });
});

describe("reschedule semantics — cancelled / partial-failed phases (review M1/M2)", () => {
  it("an operator-CANCELLED phase is NOT resurrected by an automatic reschedule", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-live-now", status: "CANCELLED", emailedKeys: [] },
    ]);
    const res = await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(res.created).toBe(3);
    expect(createdPhases()).not.toContain("webinar-live-now");
    // The clear must not delete the CANCELLED row either (no OR branch for it).
    const where = (mockDb.scheduledEmail.deleteMany.mock.calls[0][0] as {
      where: { OR: Array<{ status: string }> };
    }).where;
    expect(where.OR.map((o) => o.status)).toEqual(["PENDING", "FAILED"]);
  });

  it("the console's explicit Re-enqueue (resurrectCancelled) DOES re-create cancelled phases", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-live-now", status: "CANCELLED", emailedKeys: [] },
    ]);
    const res = await rescheduleWebinarSequenceForEvent("ev1", "u1", { resurrectCancelled: true });
    expect(res.created).toBe(4);
    expect(createdPhases()).toContain("webinar-live-now");
    const where = (mockDb.scheduledEmail.deleteMany.mock.calls[0][0] as {
      where: { OR: Array<{ status: string }> };
    }).where;
    expect(where.OR.map((o) => o.status)).toEqual(["PENDING", "FAILED", "CANCELLED"]);
  });

  it("a FAILED phase with partial deliveries keeps its resume state and is not re-created", async () => {
    // 500 of 2000 delivered → emailedKeys non-empty. Re-creating would email
    // the 500 again; the row survives for the operator's Retry instead.
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { emailType: "webinar-reminder-24h", status: "FAILED", emailedKeys: ["r1", "r2"] },
    ]);
    const res = await rescheduleWebinarSequenceForEvent("ev1", "u1");
    expect(res.created).toBe(3);
    expect(createdPhases()).not.toContain("webinar-reminder-24h");
  });
});
