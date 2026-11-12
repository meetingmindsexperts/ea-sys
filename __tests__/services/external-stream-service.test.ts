/**
 * A partner's stream key: issue, replace, switch, and the rule that decides
 * whether a publish presenting it is let in (Nov 12, 2026, external streams
 * step 2). The database is mocked; the password maths is real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    eventSession: { findFirst: vi.fn() },
    externalStream: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    zoomMeeting: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));

process.env.STREAM_PUBLISH_SECRET = "test-stream-publish-secret";
process.env.RTMP_INGEST_URL = "rtmp://box:1935/live/";

import {
  getExternalStream,
  issueExternalStream,
  replaceExternalStreamKey,
  setExternalStreamEnabled,
  updateExternalStreamDetails,
} from "@/services/external-stream-service";
import { externalPublishDecision, externalStreamCredentials } from "@/lib/webinar/external-stream";
import { streamPublishPassword } from "@/lib/webinar/livestream";

const KEY = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-12-01T09:00:00Z");
const SESSION_END = new Date("2026-12-01T12:00:00Z");
const caller = { organizationId: "org1", eventId: "ev1", sessionId: "s1", userId: "u1", source: "rest" as const };

const row = (extra: Record<string, unknown> = {}) => ({
  id: "x1",
  sessionId: "s1",
  streamKey: KEY,
  secretVersion: 1,
  enabled: true,
  validFrom: NOW,
  validUntil: null,
  issuedTo: null,
  lastPublishAt: null,
  session: { endTime: SESSION_END },
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STREAM_PUBLISH_SECRET = "test-stream-publish-secret";
  mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", zoomMeeting: null, externalStream: null });
  mockDb.externalStream.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    row({ streamKey: data.streamKey, validFrom: data.validFrom, validUntil: data.validUntil, issuedTo: data.issuedTo }),
  );
  mockDb.externalStream.findFirst.mockResolvedValue(row());
  mockDb.externalStream.updateMany.mockResolvedValue({ count: 1 });
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("externalPublishDecision", () => {
  const state = (extra: Record<string, unknown> = {}) => ({
    streamKey: KEY,
    secretVersion: 2,
    enabled: true,
    validFrom: new Date("2026-11-25T00:00:00Z"),
    validUntil: null as Date | null,
    sessionEndTime: SESSION_END,
    ...extra,
  });
  const good = streamPublishPassword(KEY, 2);

  it("lets in the right password on a key that is switched on and inside its period", () => {
    expect(externalPublishDecision(state(), good, NOW)).toEqual({ allowed: true });
  });

  it("refuses the bare key, a wrong password, and the password Zoom would hold for the same key", () => {
    for (const presented of [null, undefined, "", "wrong", streamPublishPassword(KEY)]) {
      expect(externalPublishDecision(state(), presented, NOW)).toEqual({ allowed: false, reason: "BAD_PASSWORD" });
    }
  });

  it("a replaced key: the old version's password stops working, the new one works", () => {
    const old = streamPublishPassword(KEY, 1);
    expect(old).not.toBe(good);
    expect(externalPublishDecision(state(), old, NOW)).toEqual({ allowed: false, reason: "BAD_PASSWORD" });
    expect(externalPublishDecision(state({ secretVersion: 3 }), good, NOW)).toEqual({ allowed: false, reason: "BAD_PASSWORD" });
    expect(externalPublishDecision(state({ secretVersion: 3 }), streamPublishPassword(KEY, 3), NOW)).toEqual({ allowed: true });
  });

  it("switched off is refused even with the right password", () => {
    expect(externalPublishDecision(state({ enabled: false }), good, NOW)).toEqual({ allowed: false, reason: "SWITCHED_OFF" });
  });

  it("outside its period is refused: before it starts, and after 24 hours past the session's scheduled end", () => {
    expect(externalPublishDecision(state({ validFrom: new Date("2026-12-01T09:00:01Z") }), good, NOW)).toEqual({
      allowed: false,
      reason: "NOT_YET_VALID",
    });
    const dayAfter = new Date(SESSION_END.getTime() + 24 * 3600_000);
    expect(externalPublishDecision(state(), good, dayAfter)).toEqual({ allowed: true });
    expect(externalPublishDecision(state(), good, new Date(dayAfter.getTime() + 1))).toEqual({ allowed: false, reason: "EXPIRED" });
  });

  it("a webinar moved a week later keeps its key working: the period follows the session", () => {
    const afterOldEnd = new Date("2026-12-05T10:00:00Z");
    expect(externalPublishDecision(state(), good, afterOldEnd).allowed).toBe(false);
    expect(externalPublishDecision(state({ sessionEndTime: new Date("2026-12-08T12:00:00Z") }), good, afterOldEnd)).toEqual({ allowed: true });
  });

  it("the key's own end date wins over the session's", () => {
    const own = new Date("2026-12-01T10:00:00Z");
    expect(externalPublishDecision(state({ validUntil: own }), good, new Date("2026-12-01T10:00:01Z"))).toEqual({
      allowed: false,
      reason: "EXPIRED",
    });
  });

  it("a wrong password is reported as that, whatever else is wrong with the key", () => {
    expect(externalPublishDecision(state({ enabled: false }), "wrong", NOW)).toEqual({ allowed: false, reason: "BAD_PASSWORD" });
  });
});

describe("externalStreamCredentials", () => {
  it("is the server address and key?user=publisher&pass=..., the form Zoom's custom live streaming takes", () => {
    expect(externalStreamCredentials({ streamKey: KEY, secretVersion: 4 })).toEqual({
      serverUrl: "rtmp://box:1935/live/",
      streamKey: `${KEY}?user=publisher&pass=${streamPublishPassword(KEY, 4)}`,
    });
  });
});

describe("issueExternalStream", () => {
  afterEach(() => {
    process.env.STREAM_PUBLISH_SECRET = "test-stream-publish-secret";
  });

  it("creates the row stamped with the organisation, working from now and following the session", async () => {
    const res = await issueExternalStream({ ...caller, issuedTo: "  Agency AV desk  ", now: NOW });
    expect(res.ok).toBe(true);
    const data = mockDb.externalStream.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      sessionId: "s1", eventId: "ev1", organizationId: "org1", validFrom: NOW, validUntil: null,
      issuedTo: "Agency AV desk", createdByUserId: "u1",
    });
    expect(data.streamKey).toMatch(/^[a-f0-9]{32}$/);
    if (!res.ok) return;
    expect(res.externalStream.validUntil).toEqual(new Date(SESSION_END.getTime() + 24 * 3600_000));
    expect(res.externalStream.validUntilIsOwn).toBe(false);
    expect(res.externalStream.credentials.streamKey).toContain("?user=publisher&pass=");
    // The session is bound to the event.
    expect(mockDb.eventSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "s1", eventId: "ev1" } }));
  });

  it("audits who issued it, never the key or its password", async () => {
    await issueExternalStream({ ...caller, issuedTo: "Agency", now: NOW });
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ action: "EXTERNAL_STREAM_ISSUED", entityType: "ExternalStream", userId: "u1", eventId: "ev1", organizationId: "org1" });
    const created = mockDb.externalStream.create.mock.calls[0][0].data.streamKey as string;
    expect(JSON.stringify(audit)).not.toContain(created);
    expect(JSON.stringify(audit)).not.toContain("pass=");
    expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain(created);
  });

  it("refuses while the dedicated secret is not set: a key signed with the sign-in secret dies when that is rotated", async () => {
    delete process.env.STREAM_PUBLISH_SECRET;
    const res = await issueExternalStream({ ...caller, now: NOW });
    expect(res).toMatchObject({ ok: false, code: "PUBLISH_SECRET_NOT_SET" });
    expect(mockDb.externalStream.create).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "PUBLISH_SECRET_NOT_SET" }), "external-stream:issue-refused");
  });

  it("refuses a session that has our Zoom webinar: one source or the other", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", zoomMeeting: { id: "zm1" }, externalStream: null });
    expect(await issueExternalStream({ ...caller, now: NOW })).toMatchObject({ ok: false, code: "ZOOM_WEBINAR_EXISTS" });
    expect(mockDb.externalStream.create).not.toHaveBeenCalled();
  });

  it("refuses a second key for the same session, also when two people issue at once", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", zoomMeeting: null, externalStream: { id: "x1" } });
    expect(await issueExternalStream({ ...caller, now: NOW })).toMatchObject({ ok: false, code: "ALREADY_ISSUED" });
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", zoomMeeting: null, externalStream: null });
    mockDb.externalStream.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    expect(await issueExternalStream({ ...caller, now: NOW })).toMatchObject({ ok: false, code: "ALREADY_ISSUED" });
  });

  it("any other database error is not swallowed", async () => {
    mockDb.externalStream.create.mockRejectedValue(new Error("db down"));
    await expect(issueExternalStream({ ...caller, now: NOW })).rejects.toThrow("db down");
  });

  it("refuses a session of another event, and an end date in the past", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue(null);
    expect(await issueExternalStream({ ...caller, now: NOW })).toMatchObject({ ok: false, code: "SESSION_NOT_FOUND" });
    expect(await issueExternalStream({ ...caller, now: NOW, validUntil: NOW })).toMatchObject({ ok: false, code: "INVALID_PERIOD" });
  });
});

describe("replaceExternalStreamKey", () => {
  it("adds one to the version, bound to the event, and returns credentials the old password no longer matches", async () => {
    mockDb.externalStream.findFirst
      .mockResolvedValueOnce({ id: "x1", secretVersion: 1 })
      .mockResolvedValueOnce(row({ secretVersion: 2 }));
    const res = await replaceExternalStreamKey(caller);
    expect(mockDb.externalStream.updateMany).toHaveBeenCalledWith({
      where: { id: "x1", eventId: "ev1" },
      data: { secretVersion: { increment: 1 } },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.externalStream.credentials.streamKey).toBe(`${KEY}?user=publisher&pass=${streamPublishPassword(KEY, 2)}`);
    expect(res.externalStream.credentials.streamKey).not.toContain(streamPublishPassword(KEY, 1));
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: "EXTERNAL_STREAM_KEY_REPLACED",
      changes: expect.objectContaining({ fromVersion: 1, toVersion: 2 }),
    });
  });

  it("no partner stream on the session: refused and logged", async () => {
    mockDb.externalStream.findFirst.mockResolvedValue(null);
    expect(await replaceExternalStreamKey(caller)).toMatchObject({ ok: false, code: "NOT_ISSUED" });
    expect(mockDb.externalStream.updateMany).not.toHaveBeenCalled();
  });
});

describe("setExternalStreamEnabled and updateExternalStreamDetails", () => {
  it("switches off and on, bound to the event, each audited", async () => {
    mockDb.externalStream.findFirst.mockResolvedValue(row({ enabled: false }));
    const off = await setExternalStreamEnabled({ ...caller, enabled: false });
    expect(mockDb.externalStream.updateMany).toHaveBeenCalledWith({ where: { sessionId: "s1", eventId: "ev1" }, data: { enabled: false } });
    expect(off).toMatchObject({ ok: true, externalStream: { enabled: false } });
    await setExternalStreamEnabled({ ...caller, enabled: true });
    expect(mockDb.auditLog.create.mock.calls.map((c) => c[0].data.action)).toEqual([
      "EXTERNAL_STREAM_SWITCHED_OFF",
      "EXTERNAL_STREAM_SWITCHED_ON",
    ]);
  });

  it("nothing to switch or update: refused", async () => {
    mockDb.externalStream.updateMany.mockResolvedValue({ count: 0 });
    expect(await setExternalStreamEnabled({ ...caller, enabled: false })).toMatchObject({ ok: false, code: "NOT_ISSUED" });
    expect(await updateExternalStreamDetails({ ...caller, issuedTo: "x" })).toMatchObject({ ok: false, code: "NOT_ISSUED" });
  });

  it("updates only the fields sent; an end date of null follows the session again", async () => {
    await updateExternalStreamDetails({ ...caller, issuedTo: " Studio B " });
    expect(mockDb.externalStream.updateMany.mock.calls[0][0].data).toEqual({ issuedTo: "Studio B" });
    await updateExternalStreamDetails({ ...caller, validUntil: null });
    expect(mockDb.externalStream.updateMany.mock.calls[1][0].data).toEqual({ validUntil: null });
    const own = new Date("2026-12-02T00:00:00Z");
    mockDb.externalStream.findFirst.mockResolvedValue(row({ validUntil: own }));
    const res = await updateExternalStreamDetails({ ...caller, validUntil: own, now: NOW });
    expect(res).toMatchObject({ ok: true, externalStream: { validUntil: own, validUntilIsOwn: true } });
    expect(await updateExternalStreamDetails({ ...caller, validUntil: NOW, now: NOW })).toMatchObject({ ok: false, code: "INVALID_PERIOD" });
  });
});

describe("getExternalStream", () => {
  it("is bound to the event, and null when none was issued", async () => {
    expect((await getExternalStream("ev1", "s1"))?.id).toBe("x1");
    expect(mockDb.externalStream.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: "s1", eventId: "ev1" } }));
    mockDb.externalStream.findFirst.mockResolvedValue(null);
    expect(await getExternalStream("ev1", "s1")).toBeNull();
  });
});
