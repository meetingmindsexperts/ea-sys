/**
 * session-stream.ts: the one place that answers "what is this session's
 * stream, and whose is it" (Nov 12, 2026, external streams step 1).
 *
 * The step that added it must change nothing for a Zoom webinar, so the Zoom
 * rule is pinned here exactly as every reader applied it before: live
 * streaming on AND a key. The database is mocked.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    externalStream: { findFirst: vi.fn(), updateMany: vi.fn() },
    zoomMeeting: { findFirst: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import {
  EXTERNAL_STREAM_GRACE_MS,
  externalStreamValidUntil,
  hlsPlaybackUrls,
  pickSessionStream,
  SESSION_HAS_STREAM,
  sessionStream,
  setSessionStreamStatus,
  streamKeyOwner,
} from "@/lib/webinar/session-stream";

const ZOOM_ON = { liveStreamEnabled: true, streamKey: "zoomkey", streamStatus: "ACTIVE" as const };
const EXTERNAL = { streamKey: "partnerkey", streamStatus: "IDLE" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.externalStream.findFirst.mockResolvedValue(null);
  mockDb.zoomMeeting.findFirst.mockResolvedValue(null);
});

describe("pickSessionStream", () => {
  it("a Zoom meeting counts only with live streaming on AND a key, as every reader required before", () => {
    expect(pickSessionStream({ zoomMeeting: ZOOM_ON })).toEqual({ source: "zoom", streamKey: "zoomkey", streamStatus: "ACTIVE" });
    expect(pickSessionStream({ zoomMeeting: { ...ZOOM_ON, liveStreamEnabled: false } })).toBeNull();
    expect(pickSessionStream({ zoomMeeting: { ...ZOOM_ON, streamKey: null } })).toBeNull();
    expect(pickSessionStream({ zoomMeeting: null })).toBeNull();
    expect(pickSessionStream({})).toBeNull();
  });

  it("an external stream IS the session's stream while its row exists, even beside a Zoom stream", () => {
    expect(pickSessionStream({ externalStream: EXTERNAL })).toEqual({ source: "external", streamKey: "partnerkey", streamStatus: "IDLE" });
    expect(pickSessionStream({ externalStream: EXTERNAL, zoomMeeting: ZOOM_ON })?.source).toBe("external");
  });
});

describe("sessionStream", () => {
  it("reads both rows bound to the event, so another event's session id finds nothing", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(ZOOM_ON);
    expect(await sessionStream("s1", "ev1")).toEqual({ source: "zoom", streamKey: "zoomkey", streamStatus: "ACTIVE" });
    const where = { sessionId: "s1", eventId: "ev1" };
    expect(mockDb.zoomMeeting.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(mockDb.externalStream.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where }));
  });

  it("no rows, or a Zoom meeting with streaming off: no stream", async () => {
    expect(await sessionStream("s1", "ev1")).toBeNull();
    mockDb.zoomMeeting.findFirst.mockResolvedValue({ ...ZOOM_ON, liveStreamEnabled: false });
    expect(await sessionStream("s1", "ev1")).toBeNull();
  });

  it("the external row wins", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(ZOOM_ON);
    mockDb.externalStream.findFirst.mockResolvedValue(EXTERNAL);
    expect((await sessionStream("s1", "ev1"))?.streamKey).toBe("partnerkey");
  });
});

describe("streamKeyOwner (the publish check's lookup)", () => {
  it("a Zoom key is found only while live streaming is on, the filter the check always used", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue({ eventId: "ev1", sessionId: "s1" });
    expect(await streamKeyOwner("zoomkey")).toEqual({ source: "zoom", eventId: "ev1", sessionId: "s1" });
    expect(mockDb.zoomMeeting.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { streamKey: "zoomkey", liveStreamEnabled: true } }),
    );
  });

  it("an external key is returned whatever its state, so the check can say why it refuses", async () => {
    const end = new Date("2026-12-01T12:00:00Z");
    mockDb.externalStream.findFirst.mockResolvedValue({
      id: "x1", eventId: "ev1", sessionId: "s1", secretVersion: 3, enabled: false,
      validFrom: new Date("2026-11-20T00:00:00Z"), validUntil: null, session: { endTime: end },
    });
    expect(await streamKeyOwner("partnerkey")).toEqual({
      source: "external", id: "x1", eventId: "ev1", sessionId: "s1", secretVersion: 3, enabled: false,
      validFrom: new Date("2026-11-20T00:00:00Z"), validUntil: null, sessionEndTime: end,
    });
  });

  it("an unknown key belongs to nobody", async () => {
    expect(await streamKeyOwner("nope")).toBeNull();
  });
});

describe("externalStreamValidUntil", () => {
  const sessionEndTime = new Date("2026-12-01T12:00:00Z");

  it("without its own end date a key follows the session: 24 hours after the scheduled end as it is now", () => {
    expect(externalStreamValidUntil({ validUntil: null, sessionEndTime })).toEqual(
      new Date(sessionEndTime.getTime() + EXTERNAL_STREAM_GRACE_MS),
    );
    // The webinar is postponed a week: the period moves with it, nothing stored to update.
    const moved = new Date("2026-12-08T12:00:00Z");
    expect(externalStreamValidUntil({ validUntil: null, sessionEndTime: moved })).toEqual(new Date("2026-12-09T12:00:00Z"));
  });

  it("its own end date wins", () => {
    const own = new Date("2026-12-01T13:00:00Z");
    expect(externalStreamValidUntil({ validUntil: own, sessionEndTime })).toBe(own);
  });
});

describe("setSessionStreamStatus", () => {
  const at = { sessionId: "s1", eventId: "ev1", organizationId: "org1" };

  it("writes a Zoom stream's status on ZoomMeeting, bound to the event", async () => {
    await setSessionStreamStatus({ source: "zoom", streamKey: "k", streamStatus: "IDLE" }, at, "ACTIVE");
    expect(mockDb.zoomMeeting.updateMany).toHaveBeenCalledWith({
      where: { sessionId: "s1", eventId: "ev1", liveStreamEnabled: true },
      data: { streamStatus: "ACTIVE", organizationId: "org1" },
    });
    expect(mockDb.externalStream.updateMany).not.toHaveBeenCalled();
  });

  it("writes an external stream's status on its own row, bound to the event", async () => {
    await setSessionStreamStatus({ source: "external", streamKey: "k", streamStatus: "ACTIVE" }, at, "ENDED");
    expect(mockDb.externalStream.updateMany).toHaveBeenCalledWith({
      where: { sessionId: "s1", eventId: "ev1" },
      data: { streamStatus: "ENDED", organizationId: "org1" },
    });
    expect(mockDb.zoomMeeting.updateMany).not.toHaveBeenCalled();
  });
});

describe("hlsPlaybackUrls", () => {
  const saved = { app: process.env.NEXT_PUBLIC_APP_URL, cdn: process.env.HLS_CDN_BASE };
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = saved.app;
    if (saved.cdn === undefined) delete process.env.HLS_CDN_BASE;
    else process.env.HLS_CDN_BASE = saved.cdn;
  });

  it("CloudFront first with the box as the fallback; both the box when no CDN is set", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://events.example.com";
    process.env.HLS_CDN_BASE = "https://cdn.example.net";
    expect(hlsPlaybackUrls("k1")).toEqual({
      hlsUrl: "https://cdn.example.net/stream/live/k1/index.m3u8",
      hlsOriginUrl: "https://events.example.com/stream/live/k1/index.m3u8",
    });
    delete process.env.HLS_CDN_BASE;
    expect(hlsPlaybackUrls("k1").hlsUrl).toBe("https://events.example.com/stream/live/k1/index.m3u8");
  });
});

describe("SESSION_HAS_STREAM", () => {
  it("matches a session with an external row, or a Zoom meeting streaming with a key", () => {
    expect(SESSION_HAS_STREAM).toEqual({
      OR: [
        { externalStream: { isNot: null } },
        { zoomMeeting: { is: { liveStreamEnabled: true, streamKey: { not: null } } } },
      ],
    });
  });
});

/**
 * The rule the module exists for: nobody reads a stream key from a table in a
 * new place. A reader that knows only ZoomMeeting shows a partner's webinar as
 * "no stream". This scans the source for a database read of the key and fails
 * on any file outside the list, each of which is a Zoom-only surface.
 */
describe("no new reader takes the stream key from a table", () => {
  const ALLOWED = new Set([
    // The resolver itself.
    "src/lib/webinar/session-stream.ts",
    // Tells OUR Zoom where to push: Zoom-only by definition.
    "src/lib/webinar/livestream.ts",
    // The agenda's session list, for the session's Zoom form (staff, redacted by zoom-visibility).
    "src/app/api/events/[eventId]/sessions/route.ts",
    // Loads the session's Zoom meeting to join it, and hands the pair to pickSessionStream.
    "src/app/api/public/events/[slug]/sessions/[sessionId]/zoom-join/route.ts",
  ]);
  const READS_KEY = /streamKey:\s*true|where:\s*\{[^}]*\bstreamKey\b/;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("only the listed files select or filter on streamKey", () => {
    const offenders = [...sourceFiles("src"), ...sourceFiles("worker")]
      .filter((file) => READS_KEY.test(readFileSync(file, "utf8")))
      .filter((file) => !ALLOWED.has(file));
    expect(offenders).toEqual([]);
  });

  it("every listed file still exists (a stale entry would hide a moved reader)", () => {
    for (const file of ALLOWED) expect(statSync(file).isFile()).toBe(true);
  });
});
