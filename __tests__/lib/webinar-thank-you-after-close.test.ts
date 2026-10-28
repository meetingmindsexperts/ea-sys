/**
 * The webinar thank-you follows the room close, not the scheduled end (owner, Oct 28, 2026).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    event: { findUnique: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    scheduledEmail: { updateMany: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/bulk-email", () => ({ WEBINAR_EMAIL_TYPES: [], executeBulkEmail: vi.fn() }));

import { isWebinarRoomOpen, retimeThankYouAfterRoomClose, THANK_YOU_AFTER_CLOSE_MS } from "@/lib/webinar-email-sequence";

const START = new Date("2026-11-03T10:00:00Z");
const END = new Date("2026-11-03T11:00:00Z");
const at = (iso: string) => new Date(iso);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findUnique.mockResolvedValue({ settings: { webinar: { sessionId: "anchor" } } });
  mockDb.eventSession.findFirst.mockResolvedValue({ startTime: START, endTime: END, status: "LIVE" });
  mockDb.scheduledEmail.updateMany.mockResolvedValue({ count: 1 });
});

describe("retimeThankYouAfterRoomClose", () => {
  it("an early end brings the thank-you forward to 30 minutes after the close", async () => {
    const closed = at("2026-11-03T10:40:00Z");
    expect(await retimeThankYouAfterRoomClose("ev1", closed)).toBe(1);
    const call = mockDb.scheduledEmail.updateMany.mock.calls[0][0];
    expect(call.data.scheduledFor).toEqual(new Date(closed.getTime() + THANK_YOU_AFTER_CLOSE_MS));
    // Only the sequence's own pending thank-you.
    expect(call.where).toEqual({
      eventId: "ev1", emailType: "webinar-thank-you", status: "PENDING",
      customSubject: null, customMessage: null, recipientIds: { isEmpty: true },
    });
  });

  it("an overrun moves it later, to 30 minutes after the real end", async () => {
    const closed = at("2026-11-03T12:20:00Z");
    await retimeThankYouAfterRoomClose("ev1", closed);
    expect(mockDb.scheduledEmail.updateMany.mock.calls[0][0].data.scheduledFor).toEqual(new Date(closed.getTime() + THANK_YOU_AFTER_CLOSE_MS));
  });

  it("a rehearsal days before does not send the real thank-you", async () => {
    expect(await retimeThankYouAfterRoomClose("ev1", at("2026-10-30T09:00:00Z"))).toBe(0);
    expect(mockDb.scheduledEmail.updateMany).not.toHaveBeenCalled();
  });

  it("a rehearsal two hours before the start does not either; an hour before does count", async () => {
    expect(await retimeThankYouAfterRoomClose("ev1", at("2026-11-03T08:00:00Z"))).toBe(0);
    expect(await retimeThankYouAfterRoomClose("ev1", at("2026-11-03T09:10:00Z"))).toBe(1);
  });

  it("never throws: a failure is logged and nothing moves", async () => {
    mockDb.scheduledEmail.updateMany.mockRejectedValue(new Error("db down"));
    await expect(retimeThankYouAfterRoomClose("ev1", at("2026-11-03T10:40:00Z"))).resolves.toBe(0);
  });
});

describe("isWebinarRoomOpen", () => {
  it("is the anchor session being LIVE", async () => {
    expect(await isWebinarRoomOpen("ev1")).toBe(true);
    mockDb.eventSession.findFirst.mockResolvedValue({ status: "COMPLETED" });
    expect(await isWebinarRoomOpen("ev1")).toBe(false);
    mockDb.event.findUnique.mockResolvedValue({ settings: {} });
    expect(await isWebinarRoomOpen("ev1")).toBe(false);
  });
});
