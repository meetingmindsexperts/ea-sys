/**
 * A webinar's video source and the one-source-per-session rule (Nov 12, 2026,
 * external streams step 4). The database is mocked; tenantTransaction runs its
 * callback on the same stand-in so the order of lock, look and write is seen.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, order } = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    mockDb: {
      $queryRaw: vi.fn(async () => { order.push("lock"); return []; }),
      externalStream: { findFirst: vi.fn() },
      zoomMeeting: { create: vi.fn() },
    },
  };
});
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb) }));

import {
  createZoomMeetingRow,
  isPartnerStreamExistsError,
  sessionVideoSourceLockKey,
  webinarVideoSource,
  zoomMeetingRefusal,
} from "@/lib/webinar/video-source";

const ask = (over: Record<string, unknown> = {}) =>
  zoomMeetingRefusal({ eventId: "ev1", sessionId: "s1", eventType: "WEBINAR", eventSettings: {}, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  mockDb.$queryRaw.mockImplementation(async () => { order.push("lock"); return []; });
  mockDb.externalStream.findFirst.mockImplementation(async () => { order.push("look"); return null; });
  mockDb.zoomMeeting.create.mockImplementation(async () => { order.push("write"); return { id: "zm1" }; });
});

describe("webinarVideoSource", () => {
  it("is our Zoom unless the webinar says external: every webinar made before the choice existed", () => {
    expect(webinarVideoSource({ webinar: { source: "external" } })).toBe("external");
    for (const settings of [{}, null, undefined, { webinar: {} }, { webinar: { source: "zoom" } }, { webinar: { source: "other" } }]) {
      expect(webinarVideoSource(settings)).toBe("zoom");
    }
  });
});

describe("zoomMeetingRefusal (asked before Zoom is called)", () => {
  it("allows a Zoom meeting on an ordinary session", async () => {
    expect(await ask()).toBeNull();
    expect(await ask({ eventType: "CONFERENCE" })).toBeNull();
  });

  it("refuses the webinar's own session when its video comes from a partner, also before the anchor exists", async () => {
    const external = { webinar: { source: "external", sessionId: "s1" } };
    expect(await ask({ eventSettings: external })).toMatchObject({ code: "EXTERNAL_VIDEO_SOURCE" });
    expect(await ask({ eventSettings: { webinar: { source: "external" } } })).toMatchObject({ code: "EXTERNAL_VIDEO_SOURCE" });
    // No database read was needed to say so.
    expect(mockDb.externalStream.findFirst).not.toHaveBeenCalled();
  });

  it("the source is a webinar's: a conference whose settings carry the word is not refused for it", async () => {
    expect(await ask({ eventType: "CONFERENCE", eventSettings: { webinar: { source: "external" } } })).toBeNull();
  });

  it("refuses a session that already holds a partner's stream key, looked up bound to the event", async () => {
    mockDb.externalStream.findFirst.mockResolvedValue({ id: "x1" });
    const res = await ask();
    expect(res).toMatchObject({ code: "PARTNER_STREAM_EXISTS" });
    expect(res?.message).toContain("not both");
    expect(mockDb.externalStream.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: "s1", eventId: "ev1" } }),
    );
  });
});

describe("createZoomMeetingRow (the write, under the per-session lock)", () => {
  const args = { data: { sessionId: "s1", eventId: "ev1", zoomMeetingId: "9", meetingType: "WEBINAR" as const, joinUrl: "j" } };

  it("locks the session first, looks for a partner's key, then writes", async () => {
    expect(await createZoomMeetingRow(args)).toEqual({ id: "zm1" });
    expect(order).toEqual(["lock", "look", "write"]);
    expect(mockDb.zoomMeeting.create).toHaveBeenCalledWith(args);
  });

  it("writes nothing when a partner's key landed first, and says which error it is", async () => {
    mockDb.externalStream.findFirst.mockImplementation(async () => { order.push("look"); return { id: "x1" }; });
    const err = await createZoomMeetingRow(args).catch((e: unknown) => e);
    expect(isPartnerStreamExistsError(err)).toBe(true);
    expect(order).toEqual(["lock", "look"]);
    expect(mockDb.zoomMeeting.create).not.toHaveBeenCalled();
  });

  it("another error is not mistaken for it", () => {
    expect(isPartnerStreamExistsError(Object.assign(new Error("x"), { code: "P2002" }))).toBe(false);
  });

  it("the lock is per session, and the key issue takes the same one", () => {
    expect(sessionVideoSourceLockKey("s1")).toBe("session-video-source:s1");
    expect(sessionVideoSourceLockKey("s1")).not.toBe(sessionVideoSourceLockKey("s2"));
    expect(readFileSync("src/services/external-stream-service.ts", "utf8")).toContain("lockSessionVideoSource(tx, input.sessionId)");
  });
});

/**
 * Every door that creates our Zoom meeting's row on a session that already
 * existed must go through the locked write and ask the rule first. A new door
 * that calls db.zoomMeeting.create directly would bring the race back.
 */
describe("every Zoom-creating door uses the rule", () => {
  const DOORS = [
    "src/app/api/events/[eventId]/sessions/[sessionId]/zoom/route.ts",
    "src/lib/agent/tools/webinar.ts",
  ];

  it("the Zoom form route and the agent ask before Zoom and write under the lock, never directly", () => {
    for (const file of DOORS) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain("zoomMeetingRefusal(");
      expect(source, file).toContain("createZoomMeetingRow(");
      expect(source, file).not.toMatch(/\.zoomMeeting\.create\(/);
      expect(source.indexOf("zoomMeetingRefusal("), file).toBeLessThan(source.indexOf("createZoomMeetingRow("));
    }
  });

  it("the provisioner re-attaches under the lock; its only direct write is on the session it has just created", () => {
    const source = readFileSync("src/lib/webinar-provisioner.ts", "utf8");
    expect(source).toContain("createZoomMeetingRow(");
    expect(source).toContain("zoomMeetingRefusal(");
    expect(source.match(/\.zoomMeeting\.create\(/g) ?? []).toHaveLength(1);
  });

  it("the three delete doors read a partner's keys before the delete and cut after it", () => {
    for (const [file, del] of [
      ["src/app/api/events/[eventId]/sessions/[sessionId]/route.ts", "db.eventSession.delete("],
      ["src/app/api/events/[eventId]/sessions/bulk-delete/route.ts", "db.eventSession.deleteMany("],
      ["src/app/api/events/[eventId]/route.ts", "db.event.delete("],
    ] as const) {
      const source = readFileSync(file, "utf8");
      const capture = source.indexOf("await capturePartnerStreamsBeforeDelete(");
      const deleted = source.indexOf(del, capture);
      const cut = source.indexOf("await endPartnerStreams()", deleted);
      expect(capture, file).toBeGreaterThan(-1);
      expect(deleted, file).toBeGreaterThan(capture);
      expect(cut, file).toBeGreaterThan(deleted);
    }
  });
});
