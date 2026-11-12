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
  cachedSessionStream,
  EXTERNAL_STREAM_GRACE_MS,
  externalStreamValidUntil,
  hlsPlaybackUrls,
  pickSessionStream,
  resetSessionStreamCache,
  SESSION_HAS_STREAM,
  sessionStream,
  setSessionStreamStatus,
  streamKeyOwner,
} from "@/lib/webinar/session-stream";

const ZOOM_ON = { liveStreamEnabled: true, streamKey: "zoomkey", streamStatus: "ACTIVE" as const };
const EXTERNAL = { streamKey: "partnerkey", streamStatus: "IDLE" as const };

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionStreamCache();
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

describe("cachedSessionStream (stream-status, polled by every player)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a burst of polls reads the tables once, and again only after a few seconds", async () => {
    vi.useFakeTimers();
    mockDb.zoomMeeting.findFirst.mockResolvedValue(ZOOM_ON);
    for (let i = 0; i < 50; i++) expect((await cachedSessionStream("s1", "ev1"))?.streamKey).toBe("zoomkey");
    expect(mockDb.zoomMeeting.findFirst).toHaveBeenCalledTimes(1);
    expect(mockDb.externalStream.findFirst).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3001);
    await cachedSessionStream("s1", "ev1");
    expect(mockDb.zoomMeeting.findFirst).toHaveBeenCalledTimes(2);
  });

  it("'no stream' is cached too, and each event and session has its own entry", async () => {
    await cachedSessionStream("s1", "ev1");
    await cachedSessionStream("s1", "ev1");
    expect(mockDb.zoomMeeting.findFirst).toHaveBeenCalledTimes(1);
    await cachedSessionStream("s1", "ev2");
    await cachedSessionStream("s2", "ev1");
    expect(mockDb.zoomMeeting.findFirst).toHaveBeenCalledTimes(3);
  });

  it("a status written through setSessionStreamStatus is what the next polls see, so they do not write it again", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue({ ...ZOOM_ON, streamStatus: "IDLE" });
    const first = await cachedSessionStream("s1", "ev1");
    expect(first?.streamStatus).toBe("IDLE");
    await setSessionStreamStatus(first!, { sessionId: "s1", eventId: "ev1", organizationId: "org1" }, "ACTIVE");
    expect((await cachedSessionStream("s1", "ev1"))?.streamStatus).toBe("ACTIVE");
    expect(mockDb.zoomMeeting.findFirst).toHaveBeenCalledTimes(1);
  });

  it("sessionStream itself is never cached: the readers that act on the answer always read", async () => {
    await sessionStream("s1", "ev1");
    await sessionStream("s1", "ev1");
    expect(mockDb.zoomMeeting.findFirst).toHaveBeenCalledTimes(2);
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
 * The rule the module exists for: nobody takes a stream key from a table in a
 * new place. A reader that knows only ZoomMeeting shows a partner's webinar as
 * "no stream".
 *
 * A source scan cannot know intent, so this one is blunt on purpose (review of
 * 12c4c8b8: the first version matched only `streamKey: true` and missed
 * whole-row reads, includes and property reads). EVERY file under src/ and
 * worker/ that so much as names `streamKey` is listed here with why it may.
 * A new file that names it fails until someone adds it to the list, which is
 * the moment to ask whether it should be calling session-stream.ts instead.
 *
 * What it cannot catch: a new read inside a file already listed, or a file that
 * loads a whole ZoomMeeting row and never names the key (then it is not using
 * it). Those are for review.
 */
describe("every file that names the stream key is known", () => {
  const ALLOWED = new Map<string, string>([
    ["src/lib/webinar/session-stream.ts", "the resolver"],
    ["src/lib/webinar/livestream.ts", "tells OUR Zoom where to push, and signs publish passwords: Zoom-only"],
    ["src/lib/zoom/meetings.ts", "sends the key to Zoom's API"],
    ["src/lib/webinar/stream-probe.ts", "asks MediaMTX about a key it is handed"],
    ["src/lib/zoom-visibility.ts", "names the field to redact it"],
    ["src/app/api/webhooks/mediamtx-auth/route.ts", "the publish check: asks streamKeyOwner"],
    ["src/lib/webinar/overrun.ts", "asks sessionStream"],
    ["src/lib/webinar/stream-watchdog.ts", "asks pickSessionStream and sessionStream"],
    ["src/app/api/events/[eventId]/webinar/room/route.ts", "asks sessionStream"],
    ["src/app/api/events/[eventId]/webinar/route.ts", "asks sessionStream; a comment on host fields"],
    ["src/app/api/events/[eventId]/webinar/livestream/route.ts", "asks sessionStream for the preview address"],
    ["src/app/api/public/events/[slug]/sessions/[sessionId]/stream-status/route.ts", "asks cachedSessionStream"],
    ["src/app/api/public/events/[slug]/sessions/[sessionId]/zoom-join/route.ts", "loads the Zoom meeting to join it, hands both rows to pickSessionStream"],
    ["src/app/api/events/[eventId]/sessions/[sessionId]/zoom/route.ts", "the session's Zoom form: creates and edits OUR Zoom meeting"],
    ["src/app/api/events/[eventId]/sessions/route.ts", "the agenda's session list for that form, redacted by zoom-visibility"],
    ["src/app/(dashboard)/events/[eventId]/agenda/page.tsx", "passes the Zoom meeting's key to that form"],
    ["src/components/zoom/zoom-meeting-form.tsx", "shows the Zoom meeting's stream settings to staff"],
  ]);

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("no file outside the list names streamKey", () => {
    const offenders = [...sourceFiles("src"), ...sourceFiles("worker")]
      .filter((file) => readFileSync(file, "utf8").includes("streamKey"))
      .filter((file) => !ALLOWED.has(file));
    expect(offenders).toEqual([]);
  });

  it("every listed file still exists and still names it (a stale entry would hide a moved reader)", () => {
    for (const file of ALLOWED.keys()) {
      expect(statSync(file).isFile()).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("streamKey");
    }
  });
});
