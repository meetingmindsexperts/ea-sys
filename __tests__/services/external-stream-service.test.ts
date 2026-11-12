/**
 * A partner's stream key: issue, replace, switch, and the rule that decides
 * whether a publish presenting it is let in (Nov 12, 2026, external streams
 * step 2). The database is mocked; the password maths is real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, mockLogger, control } = vi.hoisted(() => ({
  control: { isMediamtxControlConfigured: vi.fn(), disconnectPublishers: vi.fn() },
  mockDb: {
    $queryRaw: vi.fn(),
    eventSession: { findFirst: vi.fn() },
    externalStream: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    zoomMeeting: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// tenantTransaction runs its callback on the same stand-in (the locked issue, video-source.ts).
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb) }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/webinar/mediamtx-control", () => control);

process.env.STREAM_PUBLISH_SECRET = "test-stream-publish-secret";
process.env.RTMP_INGEST_URL = "rtmp://box:1935/live/";

import {
  capturePartnerStreamsBeforeDelete,
  cutExternalStream,
  getExternalStream,
  issueExternalStream,
  replaceExternalStreamKey,
  revealExternalStreamCredentials,
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
  control.isMediamtxControlConfigured.mockReturnValue(true);
  control.disconnectPublishers.mockResolvedValue({ ok: true, disconnected: 0 });
  mockDb.zoomMeeting.findFirst.mockResolvedValue(null);
  mockDb.$queryRaw.mockResolvedValue([]);
});

const actions = () => mockDb.auditLog.create.mock.calls.map((c) => c[0].data.action);

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
    // The answer carries the stream's state, never its key or password (review of 15f219c0).
    expect(res.externalStream).not.toHaveProperty("credentials");
    expect(JSON.stringify(res)).not.toContain(data.streamKey);
    expect(JSON.stringify(res)).not.toContain("pass=");
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

  it("refuses while a running stream could not be cut: the stream server's control address is not set up", async () => {
    control.isMediamtxControlConfigured.mockReturnValue(false);
    expect(await issueExternalStream({ ...caller, now: NOW })).toMatchObject({ ok: false, code: "CONTROL_API_NOT_SET" });
    expect(mockDb.externalStream.create).not.toHaveBeenCalled();
  });

  it("the secret's refusal warns that setting it changes every Zoom custom stream's password too", async () => {
    delete process.env.STREAM_PUBLISH_SECRET;
    const res = await issueExternalStream({ ...caller, now: NOW });
    expect(res.ok === false && res.message).toContain("Re-send stream settings to Zoom");
  });

  it("refuses a session that has our Zoom webinar: one source or the other", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", zoomMeeting: { id: "zm1" }, externalStream: null });
    expect(await issueExternalStream({ ...caller, now: NOW })).toMatchObject({ ok: false, code: "ZOOM_WEBINAR_EXISTS" });
    expect(mockDb.externalStream.create).not.toHaveBeenCalled();
  });

  it("writes under the per-session lock, and a Zoom meeting created in that instant wins: no key is issued", async () => {
    const order: string[] = [];
    mockDb.$queryRaw.mockImplementation(async () => { order.push("lock"); return []; });
    mockDb.zoomMeeting.findFirst.mockImplementation(async () => { order.push("look"); return null; });
    mockDb.externalStream.create.mockImplementation(async () => { order.push("write"); return row(); });
    expect((await issueExternalStream({ ...caller, now: NOW })).ok).toBe(true);
    expect(order).toEqual(["lock", "look", "write"]);

    // The pre-flight saw no Zoom meeting; inside the lock one is there.
    mockDb.externalStream.create.mockClear();
    mockDb.zoomMeeting.findFirst.mockResolvedValue({ id: "zm1" });
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
      // The time is the sweep's evidence that a connection still running began on the old key.
      data: { secretVersion: { increment: 1 }, keyReplacedAt: expect.any(Date) },
    });
    expect(res).toMatchObject({ ok: true, externalStream: { secretVersion: 2 } });
    expect(JSON.stringify(res)).not.toContain(KEY);
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

describe("revealExternalStreamCredentials (the only place the key leaves the service)", () => {
  it("returns the two values the partner types in, for the key's current version, and audits who looked", async () => {
    mockDb.externalStream.findFirst.mockResolvedValue({ id: "x1", streamKey: KEY, secretVersion: 3 });
    const res = await revealExternalStreamCredentials(caller);
    expect(res).toEqual({
      ok: true,
      credentials: { serverUrl: "rtmp://box:1935/live/", streamKey: `${KEY}?user=publisher&pass=${streamPublishPassword(KEY, 3)}` },
    });
    expect(mockDb.externalStream.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: "s1", eventId: "ev1" } }));
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ action: "EXTERNAL_STREAM_KEY_SHOWN", userId: "u1", entityId: "x1" });
    expect(JSON.stringify(audit)).not.toContain(KEY);
    expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain(KEY);
  });

  it("refuses when nothing was issued, and when the dedicated secret is missing: never a value signed with the sign-in secret", async () => {
    mockDb.externalStream.findFirst.mockResolvedValue(null);
    expect(await revealExternalStreamCredentials(caller)).toMatchObject({ ok: false, code: "NOT_ISSUED" });
    mockDb.externalStream.findFirst.mockResolvedValue({ id: "x1", streamKey: KEY, secretVersion: 3 });
    delete process.env.STREAM_PUBLISH_SECRET;
    process.env.NEXTAUTH_SECRET = "the-sign-in-secret";
    expect(await revealExternalStreamCredentials(caller)).toMatchObject({ ok: false, code: "PUBLISH_SECRET_NOT_SET" });
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("no other function returns the key: issue, replace, switch, update and get answers never contain it", async () => {
    mockDb.externalStream.findFirst.mockResolvedValue(row());
    const answers = [
      await replaceExternalStreamKey(caller),
      await setExternalStreamEnabled({ ...caller, enabled: false }),
      await setExternalStreamEnabled({ ...caller, enabled: true }),
      await updateExternalStreamDetails({ ...caller, issuedTo: "x" }),
      await cutExternalStream(caller),
      await getExternalStream(caller),
    ];
    expect(JSON.stringify(answers)).not.toContain(KEY);
    expect(JSON.stringify(answers)).not.toContain("pass=");
  });
});

describe("a partner's password is never signed with the sign-in secret", () => {
  it("streamPublishPassword with a version throws without STREAM_PUBLISH_SECRET; Zoom's (no version) keeps its fallback", () => {
    delete process.env.STREAM_PUBLISH_SECRET;
    process.env.NEXTAUTH_SECRET = "the-sign-in-secret";
    expect(() => streamPublishPassword(KEY, 1)).toThrow(/STREAM_PUBLISH_SECRET/);
    expect(streamPublishPassword(KEY)).toMatch(/^[a-f0-9]{40}$/);
    process.env.STREAM_PUBLISH_SECRET = "test-stream-publish-secret";
  });
});

describe("ending the running stream (cut the feed)", () => {
  it("replacing disconnects whoever is publishing, AFTER the new version is saved, so a reconnect is refused", async () => {
    const order: string[] = [];
    mockDb.externalStream.findFirst
      .mockResolvedValueOnce({ id: "x1", secretVersion: 1 })
      .mockResolvedValueOnce(row({ secretVersion: 2 }));
    mockDb.externalStream.updateMany.mockImplementation(async () => { order.push("saved"); return { count: 1 }; });
    control.disconnectPublishers.mockImplementation(async () => { order.push("disconnected"); return { ok: true, disconnected: 1 }; });
    const res = await replaceExternalStreamKey(caller);
    expect(order).toEqual(["saved", "disconnected"]);
    expect(control.disconnectPublishers).toHaveBeenCalledWith(KEY);
    expect(res).toMatchObject({ ok: true, disconnect: { ok: true, disconnected: 1 } });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ disconnected: 1 });
  });

  it("switching off disconnects, after the switch is saved; switching on does not", async () => {
    const order: string[] = [];
    mockDb.externalStream.updateMany.mockImplementation(async () => { order.push("saved"); return { count: 1 }; });
    control.disconnectPublishers.mockImplementation(async () => { order.push("disconnected"); return { ok: true, disconnected: 1 }; });
    mockDb.externalStream.findFirst.mockResolvedValue(row({ enabled: false }));
    expect(await setExternalStreamEnabled({ ...caller, enabled: false })).toMatchObject({ ok: true, disconnect: { ok: true, disconnected: 1 } });
    expect(order).toEqual(["saved", "disconnected"]);
    control.disconnectPublishers.mockClear();
    const on = await setExternalStreamEnabled({ ...caller, enabled: true });
    expect(control.disconnectPublishers).not.toHaveBeenCalled();
    expect(on.ok && on.disconnect).toBeUndefined();
  });

  it("after a cut, switching on again accepts the same password: a cut is not a replacement", async () => {
    mockDb.externalStream.findFirst.mockResolvedValue(row({ enabled: false }));
    await cutExternalStream(caller);
    mockDb.externalStream.findFirst.mockResolvedValue(row({ enabled: true }));
    await setExternalStreamEnabled({ ...caller, enabled: true });
    const writes = mockDb.externalStream.updateMany.mock.calls.map((c) => c[0].data);
    expect(writes).toEqual([{ enabled: false }, { enabled: true }]);
    const state = { streamKey: KEY, secretVersion: 1, enabled: true, validFrom: NOW, validUntil: null, sessionEndTime: SESSION_END };
    expect(externalPublishDecision(state, streamPublishPassword(KEY, 1), NOW)).toEqual({ allowed: true });
  });

  it("cut the feed is switching off: the key is off and the stream is disconnected", async () => {
    mockDb.externalStream.findFirst.mockResolvedValue(row({ enabled: false }));
    const res = await cutExternalStream(caller);
    expect(mockDb.externalStream.updateMany).toHaveBeenCalledWith({ where: { sessionId: "s1", eventId: "ev1" }, data: { enabled: false } });
    expect(control.disconnectPublishers).toHaveBeenCalledWith(KEY);
    expect(res).toMatchObject({ ok: true, externalStream: { enabled: false } });
    expect(actions()).toEqual(["EXTERNAL_STREAM_SWITCHED_OFF"]);
  });

  it("a disconnect that fails is returned for the producer to see, logged and audited; the key is still off", async () => {
    control.disconnectPublishers.mockResolvedValue({ ok: false, code: "UNREACHABLE", message: "The stream server did not answer." });
    mockDb.externalStream.findFirst.mockResolvedValue(row({ enabled: false }));
    const res = await cutExternalStream(caller);
    expect(res).toMatchObject({ ok: true, externalStream: { enabled: false }, disconnect: { ok: false, code: "UNREACHABLE" } });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "UNREACHABLE", op: "switch-off" }), "external-stream:disconnect-failed");
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ disconnectFailed: "UNREACHABLE" });
  });

  it("nothing to switch: nothing is disconnected", async () => {
    mockDb.externalStream.updateMany.mockResolvedValue({ count: 0 });
    expect(await cutExternalStream(caller)).toMatchObject({ ok: false, code: "NOT_ISSUED" });
    expect(control.disconnectPublishers).not.toHaveBeenCalled();
  });
});

describe("getExternalStream", () => {
  it("is bound to the event, and null when none was issued", async () => {
    const view = await getExternalStream({ eventId: "ev1", sessionId: "s1" });
    expect(view?.id).toBe("x1");
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(mockDb.externalStream.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: "s1", eventId: "ev1" } }));
    mockDb.externalStream.findFirst.mockResolvedValue(null);
    expect(await getExternalStream({ eventId: "ev1", sessionId: "s1" })).toBeNull();
  });
});

describe("capturePartnerStreamsBeforeDelete (a session or event deleted with a partner still streaming)", () => {
  beforeEach(() => {
    mockDb.externalStream.findMany.mockResolvedValue([{ sessionId: "s1", streamKey: KEY }]);
  });

  it("reads the keys before the delete and disconnects only when the returned function is called, after it", async () => {
    const end = await capturePartnerStreamsBeforeDelete({ eventId: "ev1", sessionIds: ["s1", "s2"] });
    expect(mockDb.externalStream.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: "ev1", sessionId: { in: ["s1", "s2"] } } }),
    );
    // Nothing is cut yet: the key still exists, and an encoder cut now would reconnect straight away.
    expect(control.disconnectPublishers).not.toHaveBeenCalled();
    await end();
    expect(control.disconnectPublishers).toHaveBeenCalledWith(KEY);
  });

  it("a whole event: every partner stream of the event", async () => {
    await (await capturePartnerStreamsBeforeDelete({ eventId: "ev1" }))();
    expect(mockDb.externalStream.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { eventId: "ev1" } }));
  });

  it("never throws: a lookup error, a refused disconnect or an unreachable stream server must not fail the delete", async () => {
    control.disconnectPublishers.mockResolvedValue({ ok: false, code: "UNREACHABLE", message: "x" });
    await expect((await capturePartnerStreamsBeforeDelete({ eventId: "ev1" }))()).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", code: "UNREACHABLE" }),
      "external-stream:disconnect-after-delete-failed",
    );
    control.disconnectPublishers.mockRejectedValue(new Error("boom"));
    await expect((await capturePartnerStreamsBeforeDelete({ eventId: "ev1" }))()).resolves.toBeUndefined();
    mockDb.externalStream.findMany.mockRejectedValue(new Error("db down"));
    const end = await capturePartnerStreamsBeforeDelete({ eventId: "ev1" });
    await expect(end()).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.anything(), "external-stream:capture-before-delete-errored");
  });

  it("no log line carries the key", async () => {
    control.disconnectPublishers.mockResolvedValue({ ok: true, disconnected: 1 });
    await (await capturePartnerStreamsBeforeDelete({ eventId: "ev1" }))();
    expect(JSON.stringify([mockLogger.info.mock.calls, mockLogger.warn.mock.calls])).not.toContain(KEY);
  });
});
