/**
 * The minute sweep that disconnects a partner's stream still running on a key
 * that may no longer be used (Nov 12, 2026, external streams step 3). What
 * matters most is what it must NEVER do: cut a stream it cannot place.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger, control, ownerSpy } = vi.hoisted(() => ({
  mockDb: { auditLog: { create: vi.fn() } },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  control: { isMediamtxControlConfigured: vi.fn(), listPublishers: vi.fn(), kickPublisher: vi.fn(), publisherDetails: vi.fn() },
  ownerSpy: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/webinar/mediamtx-control", () => control);
vi.mock("@/lib/webinar/session-stream", async (orig) => ({
  ...(await orig<typeof import("@/lib/webinar/session-stream")>()),
  streamKeyOwner: ownerSpy,
}));

import { resetExternalStreamSweep, sweepExternalPublishers } from "@/lib/webinar/external-stream-sweep";

const KEY = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-12-01T12:00:00Z");
/** A live path's publisher, as the path list gives it: no address and no start time. */
const publisher = (path = `live/${KEY}`, id = "c1") => ({ id, family: "rtmpconns" as const, path });
/** What MediaMTX says about one connection when asked: it began at 11:00. */
const details = (connectedAt: Date | null = new Date("2026-12-01T11:00:00Z")) => ({ remoteAddr: "203.0.113.9:5000", connectedAt });
const external = (extra: Record<string, unknown> = {}) => ({
  source: "external" as const,
  id: "x1",
  eventId: "ev1",
  sessionId: "s1",
  secretVersion: 1,
  keyReplacedAt: null,
  enabled: true,
  validFrom: new Date("2026-11-30T00:00:00Z"),
  validUntil: null,
  sessionEndTime: new Date("2026-12-01T13:00:00Z"),
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetExternalStreamSweep();
  control.isMediamtxControlConfigured.mockReturnValue(true);
  control.listPublishers.mockResolvedValue({ ok: true, publishers: [publisher()] });
  control.kickPublisher.mockResolvedValue(true);
  control.publisherDetails.mockResolvedValue(details());
  ownerSpy.mockResolvedValue(external());
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("sweepExternalPublishers", () => {
  it("leaves a partner's stream alone while its key is switched on and inside its period", async () => {
    expect(await sweepExternalPublishers(NOW)).toEqual({ checked: 1, disconnected: 0 });
    expect(control.kickPublisher).not.toHaveBeenCalled();
    // A key never replaced needs no start time: the connection is not asked about.
    expect(control.publisherDetails).not.toHaveBeenCalled();
  });

  it("disconnects one still running after its key was switched off, with the reason logged and audited", async () => {
    ownerSpy.mockResolvedValue(external({ enabled: false }));
    expect(await sweepExternalPublishers(NOW)).toEqual({ checked: 1, disconnected: 1 });
    expect(control.kickPublisher).toHaveBeenCalledWith(publisher());
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "ev1", reason: "SWITCHED_OFF" }),
      "external-stream-sweep:disconnected",
    );
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: "EXTERNAL_STREAM_DISCONNECTED",
      entityId: "x1",
      eventId: "ev1",
      changes: expect.objectContaining({ reason: "SWITCHED_OFF", source: "worker" }),
    });
  });

  it("disconnects one running past the end of its period: 24 hours after the session's scheduled end", async () => {
    const late = new Date("2026-12-02T13:00:01Z");
    expect(await sweepExternalPublishers(new Date("2026-12-02T13:00:00Z"))).toMatchObject({ disconnected: 0 });
    expect(await sweepExternalPublishers(late)).toMatchObject({ disconnected: 1 });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "EXPIRED" }), "external-stream-sweep:disconnected");
  });

  it("NEVER touches a publisher whose key it cannot find: 'unknown' is not 'not allowed'. It says so once, not every minute", async () => {
    ownerSpy.mockResolvedValue(null);
    expect(await sweepExternalPublishers(NOW)).toEqual({ checked: 0, disconnected: 0 });
    await sweepExternalPublishers(NOW);
    await sweepExternalPublishers(NOW);
    expect(control.kickPublisher).not.toHaveBeenCalled();
    const said = mockLogger.warn.mock.calls.filter((c) => c[1] === "external-stream-sweep:publisher-on-unknown-key");
    expect(said).toHaveLength(1);
    // The connection's id is what ending it by hand needs; the key is never logged.
    expect(said[0][0]).toEqual({ connectionId: "c1", family: "rtmpconns" });
    expect(JSON.stringify(said)).not.toContain(KEY);
    expect(control.publisherDetails).not.toHaveBeenCalled();
  });

  it("disconnects a stream that began BEFORE the key was last replaced: it can only be on an old password", async () => {
    ownerSpy.mockResolvedValue(external({ keyReplacedAt: new Date("2026-12-01T11:30:00Z") }));
    expect(await sweepExternalPublishers(NOW)).toEqual({ checked: 1, disconnected: 1 });
    expect(control.publisherDetails).toHaveBeenCalledWith(publisher());
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "KEY_REPLACED" }), "external-stream-sweep:disconnected");
  });

  it("the moment of replacement itself is not 'before': a connection that began at that instant stays", async () => {
    ownerSpy.mockResolvedValue(external({ keyReplacedAt: new Date("2026-12-01T11:00:00.000Z") }));
    expect(await sweepExternalPublishers(NOW)).toEqual({ checked: 1, disconnected: 0 });
    control.publisherDetails.mockResolvedValue(details(new Date("2026-12-01T10:59:59.999Z")));
    expect(await sweepExternalPublishers(NOW)).toEqual({ checked: 1, disconnected: 1 });
  });

  it("leaves a stream that connected AFTER the replacement (the new key)", async () => {
    ownerSpy.mockResolvedValue(external({ keyReplacedAt: new Date("2026-12-01T10:30:00Z") }));
    expect(await sweepExternalPublishers(NOW)).toEqual({ checked: 1, disconnected: 0 });
    expect(control.kickPublisher).not.toHaveBeenCalled();
  });

  it("leaves one whose start time is not known, and says so once: a silent no is a check that does nothing", async () => {
    ownerSpy.mockResolvedValue(external({ keyReplacedAt: new Date("2026-12-01T11:30:00Z") }));
    for (const unknown of [details(null), null]) {
      resetExternalStreamSweep();
      mockLogger.warn.mockClear();
      control.publisherDetails.mockResolvedValue(unknown);
      expect(await sweepExternalPublishers(NOW)).toEqual({ checked: 1, disconnected: 0 });
      await sweepExternalPublishers(NOW);
      const said = mockLogger.warn.mock.calls.filter((c) => c[1] === "external-stream-sweep:replaced-key-start-unknown");
      expect(said).toHaveLength(1);
      expect(said[0][0]).toEqual({ eventId: "ev1", sessionId: "s1" });
    }
    expect(control.kickPublisher).not.toHaveBeenCalled();
  });

  it("a key that says no is acted on without asking when the connection began", async () => {
    ownerSpy.mockResolvedValue(external({ enabled: false, keyReplacedAt: new Date("2026-12-01T11:30:00Z") }));
    expect(await sweepExternalPublishers(NOW)).toEqual({ checked: 1, disconnected: 1 });
    expect(control.publisherDetails).not.toHaveBeenCalled();
  });

  it("disconnects one on a key whose period has not started", async () => {
    ownerSpy.mockResolvedValue(external({ validFrom: new Date("2026-12-01T12:00:01Z") }));
    expect(await sweepExternalPublishers(NOW)).toMatchObject({ disconnected: 1 });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "NOT_YET_VALID" }), "external-stream-sweep:disconnected");
  });

  it("never touches our own Zoom's stream, or a path that is not a stream key", async () => {
    ownerSpy.mockResolvedValue({ source: "zoom", eventId: "ev1", sessionId: "s1" });
    await sweepExternalPublishers(NOW);
    control.listPublishers.mockResolvedValue({ ok: true, publishers: [publisher("other/thing"), publisher("live/not-a-key")] });
    await sweepExternalPublishers(NOW);
    expect(control.kickPublisher).not.toHaveBeenCalled();
    expect(ownerSpy).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the control API is not set up, or its list cannot be read", async () => {
    control.isMediamtxControlConfigured.mockReturnValue(false);
    expect(await sweepExternalPublishers(NOW)).toEqual({ checked: 0, disconnected: 0 });
    expect(control.listPublishers).not.toHaveBeenCalled();
    control.isMediamtxControlConfigured.mockReturnValue(true);
    control.listPublishers.mockResolvedValue({ ok: false, code: "BAD_ANSWER" });
    expect(await sweepExternalPublishers(NOW)).toEqual({ checked: 0, disconnected: 0 });
    expect(control.kickPublisher).not.toHaveBeenCalled();
  });

  it("a kick that does not happen is logged and not counted; it is tried again next minute", async () => {
    ownerSpy.mockResolvedValue(external({ enabled: false }));
    control.kickPublisher.mockResolvedValue(false);
    expect(await sweepExternalPublishers(NOW)).toEqual({ checked: 1, disconnected: 0 });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "SWITCHED_OFF" }), "external-stream-sweep:disconnect-failed");
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("one stream's failure never stops the others", async () => {
    const other = "f".repeat(32);
    control.listPublishers.mockResolvedValue({ ok: true, publishers: [publisher(`live/${KEY}`, "c1"), publisher(`live/${other}`, "c2")] });
    ownerSpy.mockRejectedValueOnce(new Error("db blip")).mockResolvedValueOnce(external({ enabled: false }));
    expect(await sweepExternalPublishers(NOW)).toEqual({ checked: 1, disconnected: 1 });
    expect(mockLogger.error).toHaveBeenCalledWith(expect.anything(), "external-stream-sweep:publisher-failed");
  });
});
