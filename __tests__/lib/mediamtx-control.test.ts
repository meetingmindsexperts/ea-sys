/**
 * The client for MediaMTX's control API (Nov 12, 2026, external streams step
 * 3). Not verified against a running server when written, so what is pinned
 * here is that it FAILS SAFE: an answer it cannot read is never "nobody is
 * publishing", and only the connection a path names as its publisher is ever
 * disconnected.
 *
 * It asks about PATHS, never about connections (review of 132b7d29): the
 * connection list grows with every idle socket anyone opens on port 1935, so a
 * flood of them made "cut the feed" fail. A test below pins that the
 * connection lists are never asked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockLogger } = vi.hoisted(() => ({ mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));

import {
  disconnectPublishers,
  isMediamtxControlConfigured,
  isValidControlCaller,
  kickPublisher,
  listPublishers,
  MEDIAMTX_API_SECRET_MIN_LENGTH,
  publisherDetails,
} from "@/lib/webinar/mediamtx-control";

const SECRET = "s".repeat(40);
const KEY = "0123456789abcdef0123456789abcdef";
const BASE = "http://ea-sys-mediamtx:9997";
const fetchMock = vi.fn();
const json = (status: number, body: unknown) => ({ status, json: async () => body });
/** What MediaMTX 1.17.1 answers for something that does not exist. */
const notFound = (error: string) => json(404, { status: "error", error });
const CREATED = "2026-12-01T09:00:00.123456789+04:00";
/** A path as MediaMTX lists it: `source` names the publishing connection, or is null. */
const livePath = (name: string, id: string | null, type = "rtmpConn") => ({
  name,
  confName: "all",
  ready: true,
  source: id === null ? null : { type, id },
  readers: [{ type: "hlsMuxer", id: "" }],
});
const page = (items: unknown[], pageCount = 1) => json(200, { pageCount, itemCount: items.length, items });

/** Answers by URL: the path list, one path, one connection, and the kick. Anything else is some other server's 404. */
function serve(routes: { list?: unknown; path?: unknown; conn?: unknown; kick?: (id: string) => unknown }) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/v3/paths/list")) return routes.list ?? page([]);
    if (url.includes("/v3/paths/get/")) return routes.path ?? notFound("path not found");
    if (/\/v3\/rtmps?conns\/get\//.test(url)) return routes.conn ?? notFound("connection not found");
    const kick = /\/v3\/rtmps?conns\/kick\/(.+)$/.exec(url);
    if (kick) return routes.kick ? routes.kick(decodeURIComponent(kick[1])) : json(200, { status: "ok" });
    return json(404, null);
  });
}
const asked = () => fetchMock.mock.calls.map(([url]) => String(url).replace(BASE, ""));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  process.env.MEDIAMTX_API_URL = "http://ea-sys-mediamtx:9997/";
  process.env.MEDIAMTX_API_SECRET = SECRET;
  serve({});
});
afterEach(() => {
  delete process.env.MEDIAMTX_API_URL;
  delete process.env.MEDIAMTX_API_SECRET;
});

describe("configuration", () => {
  it("needs both the address and a secret long enough to be unguessable at a public webhook", () => {
    expect(isMediamtxControlConfigured()).toBe(true);
    process.env.MEDIAMTX_API_SECRET = "x".repeat(MEDIAMTX_API_SECRET_MIN_LENGTH - 1);
    expect(isMediamtxControlConfigured()).toBe(false);
    process.env.MEDIAMTX_API_SECRET = SECRET;
    delete process.env.MEDIAMTX_API_URL;
    expect(isMediamtxControlConfigured()).toBe(false);
  });

  it("not configured: nothing is called and every function says so", async () => {
    delete process.env.MEDIAMTX_API_URL;
    expect(await listPublishers()).toEqual({ ok: false, code: "NOT_CONFIGURED" });
    expect(await disconnectPublishers(KEY)).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("isValidControlCaller (the webhook's question)", () => {
  it("only our user with the exact secret", () => {
    expect(isValidControlCaller("ea-sys", SECRET)).toBe(true);
    expect(isValidControlCaller("ea-sys", SECRET + "x")).toBe(false);
    expect(isValidControlCaller("ea-sys", SECRET.slice(1))).toBe(false);
    expect(isValidControlCaller("admin", SECRET)).toBe(false);
    expect(isValidControlCaller("ea-sys", "")).toBe(false);
    expect(isValidControlCaller(undefined, undefined)).toBe(false);
  });

  it("nobody while the secret is unset or too short, even presenting the same short value", () => {
    process.env.MEDIAMTX_API_SECRET = "short";
    expect(isValidControlCaller("ea-sys", "short")).toBe(false);
    delete process.env.MEDIAMTX_API_SECRET;
    expect(isValidControlCaller("ea-sys", "")).toBe(false);
    expect(isValidControlCaller("ea-sys", "undefined")).toBe(false);
  });
});

describe("listPublishers (the minute sweep's question)", () => {
  it("asks for the live paths with our user and the secret as HTTP Basic, and returns each path's publishing connection", async () => {
    serve({
      list: page([
        livePath(`live/${KEY}`, "conn-a"),
        livePath("live/secure", "conn-s", "rtmpsConn"),
        // A path with readers and no publisher, and one fed by something that is not RTMP: neither is a publisher we can end.
        livePath("live/empty", null),
        livePath("live/other-protocol", "x", "srtConn"),
      ]),
    });
    expect(await listPublishers()).toEqual({
      ok: true,
      publishers: [
        { id: "conn-a", family: "rtmpconns", path: `live/${KEY}` },
        { id: "conn-s", family: "rtmpsconns", path: "live/secure" },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v3/paths/list?itemsPerPage=100&page=0`);
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from(`ea-sys:${SECRET}`).toString("base64")}`);
  });

  it("never asks for the connection lists: they grow with every idle socket on port 1935 (review of 132b7d29)", async () => {
    serve({ list: page([livePath(`live/${KEY}`, "conn-a")]), path: json(200, livePath(`live/${KEY}`, "conn-a")) });
    await listPublishers();
    await disconnectPublishers(KEY);
    expect(asked().some((url) => /conns\/list/.test(url))).toBe(false);
    expect(asked()).toEqual(["/v3/paths/list?itemsPerPage=100&page=0", `/v3/paths/get/live/${KEY}`, "/v3/rtmpconns/kick/conn-a"]);
  });

  it("reads every page, and exactly as many pages as the cap is still an answer", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const n = Number(/page=(\d+)$/.exec(url)?.[1]);
      return page([livePath(`live/p${n}`, `c${n}`)], 10);
    });
    const res = await listPublishers();
    expect(res.ok && res.publishers.map((p) => p.id)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"]);
  });

  it("more pages than it reads is BAD_ANSWER: a publisher could be on a page never seen", async () => {
    serve({ list: page([livePath("live/x", "a")], 11) });
    expect(await listPublishers()).toEqual({ ok: false, code: "BAD_ANSWER" });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ pages: 10 }), "mediamtx-control:list-too-long");
    // Bounded: it stops asking.
    expect(asked()).toHaveLength(10);
  });

  it("an answer it cannot read is BAD_ANSWER, never an empty list, and is logged by status and shape only", async () => {
    const unreadable = [
      json(200, null),
      json(200, { items: "x" }),
      json(200, { pageCount: 1 }),
      json(500, {}),
      json(404, null),
      // One path it cannot read fails the page: it could be the one that has to go.
      page([livePath("live/x", "a"), { source: { type: "rtmpConn", id: "b" } }]),
      page([{ name: "live/x", source: { type: "rtmpConn" } }]),
      page([{ name: "live/x", source: "conn-a" }]),
    ];
    for (const bad of unreadable) {
      serve({ list: bad });
      expect(await listPublishers()).toEqual({ ok: false, code: "BAD_ANSWER" });
    }
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ what: "list", status: 200, answer: "object" }),
      "mediamtx-control:answer-not-understood",
    );
  });

  it("refused (the webhook said no) and unreachable are told apart, and logged", async () => {
    serve({ list: json(401, {}) });
    expect(await listPublishers()).toEqual({ ok: false, code: "REFUSED" });
    fetchMock.mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    expect(await listPublishers()).toEqual({ ok: false, code: "UNREACHABLE" });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "ECONNREFUSED" }), "mediamtx-control:unreachable");
  });

  it("a quiet server is quiet: no publisher, no warning (the sweep asks every minute)", async () => {
    expect(await listPublishers()).toEqual({ ok: true, publishers: [] });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe("publisherDetails (asked only to judge a replaced key)", () => {
  const publisher = { id: "conn-a", family: "rtmpconns" as const, path: `live/${KEY}` };

  it("where it connects from and when it began, read from Go's nine-digit timestamp", async () => {
    serve({ conn: json(200, { id: "conn-a", created: CREATED, remoteAddr: "203.0.113.9:5000", state: "publish", query: "user=publisher&pass=hunter2" }) });
    expect(await publisherDetails(publisher)).toEqual({ remoteAddr: "203.0.113.9:5000", connectedAt: new Date("2026-12-01T05:00:00.123Z") });
    expect(asked()).toEqual(["/v3/rtmpconns/get/conn-a"]);
  });

  it("a start time it cannot read is null, never a guess: not text, not missing, not Go's zero time", async () => {
    for (const created of ["soon", undefined, 5, "0001-01-01T00:00:00Z"]) {
      serve({ conn: json(200, { id: "conn-a", created, remoteAddr: "203.0.113.9:5000" }) });
      expect((await publisherDetails(publisher))?.connectedAt).toBeNull();
    }
  });

  it("a connection that has gone, an answer it cannot read, or no answer at all is null", async () => {
    expect(await publisherDetails(publisher)).toBeNull();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    serve({ conn: json(500, null) });
    expect(await publisherDetails(publisher)).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ what: "connection", status: 500 }), "mediamtx-control:answer-not-understood");
    fetchMock.mockRejectedValue(new Error("down"));
    expect(await publisherDetails(publisher)).toBeNull();
  });
});

describe("kickPublisher and disconnectPublishers", () => {
  const publisher = { id: "a", family: "rtmpconns" as const, path: `live/${KEY}` };

  it("a kick that succeeds, or that MediaMTX says found the connection already gone, is done; anything else is not", async () => {
    serve({ kick: () => json(200, { status: "ok" }) });
    expect(await kickPublisher(publisher)).toBe(true);
    serve({ kick: () => notFound("connection not found") });
    expect(await kickPublisher(publisher)).toBe(true);
    // A bare 404 is some other server answering (a moved API): the stream may still be running.
    serve({ kick: () => json(404, null) });
    expect(await kickPublisher(publisher)).toBe(false);
    serve({ kick: () => json(404, {}) });
    expect(await kickPublisher(publisher)).toBe(false);
    serve({ kick: () => json(500, {}) });
    expect(await kickPublisher(publisher)).toBe(false);
    fetchMock.mockRejectedValue(new Error("down"));
    expect(await kickPublisher(publisher)).toBe(false);
  });

  it("asks this key's own path who feeds it and disconnects that connection, on the right address for its kind", async () => {
    serve({ path: json(200, livePath(`live/${KEY}`, "mine")) });
    expect(await disconnectPublishers(KEY)).toEqual({ ok: true, disconnected: 1 });
    expect(asked()).toEqual([`/v3/paths/get/live/${KEY}`, "/v3/rtmpconns/kick/mine"]);
    fetchMock.mockClear();
    serve({ path: json(200, livePath(`live/${KEY}`, "mine-s", "rtmpsConn")) });
    expect(await disconnectPublishers(KEY)).toEqual({ ok: true, disconnected: 1 });
    expect(asked()).toEqual([`/v3/paths/get/live/${KEY}`, "/v3/rtmpsconns/kick/mine-s"]);
  });

  it("nobody publishing (no such path, or a path with only viewers): zero, and nothing is kicked", async () => {
    expect(await disconnectPublishers(KEY)).toEqual({ ok: true, disconnected: 0 });
    serve({ path: json(200, livePath(`live/${KEY}`, null)) });
    expect(await disconnectPublishers(KEY)).toEqual({ ok: true, disconnected: 0 });
    expect(asked().some((url) => url.includes("/kick/"))).toBe(false);
  });

  it("an answer about the path it cannot read is a failure, never 'nobody': a bare 404, another path, a publisher it cannot end", async () => {
    const unreadable = [
      json(404, null),
      json(404, {}),
      json(200, null),
      json(200, { source: { type: "rtmpConn", id: "mine" } }),
      json(200, livePath(`live/${"f".repeat(32)}`, "someone-else")),
      json(200, livePath(`live/${KEY}`, "mine", "srtConn")),
      json(500, {}),
    ];
    for (const bad of unreadable) {
      serve({ path: bad });
      expect(await disconnectPublishers(KEY)).toMatchObject({ ok: false, code: "BAD_ANSWER" });
    }
    expect(asked().some((url) => url.includes("/kick/"))).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ sourceType: "srtConn" }), "mediamtx-control:publisher-not-rtmp");
  });

  it("refused, unreachable, or a kick that does not happen is a failure the caller can show", async () => {
    serve({ path: json(401, {}) });
    expect(await disconnectPublishers(KEY)).toMatchObject({ ok: false, code: "REFUSED" });
    serve({ path: json(200, livePath(`live/${KEY}`, "mine")), kick: () => json(500, {}) });
    expect(await disconnectPublishers(KEY)).toMatchObject({ ok: false, code: "REFUSED" });
    fetchMock.mockRejectedValue(new Error("down"));
    expect(await disconnectPublishers(KEY)).toMatchObject({ ok: false, code: "UNREACHABLE" });
  });

  it("no log line carries the stream key or the secret", async () => {
    serve({ path: json(200, livePath(`live/${KEY}`, "mine")), kick: () => json(500, {}) });
    await disconnectPublishers(KEY);
    serve({ path: json(200, livePath(`live/${KEY}`, "mine")) });
    await disconnectPublishers(KEY);
    serve({ path: json(200, { unexpected: KEY }) });
    await disconnectPublishers(KEY);
    serve({ list: page([{ name: `live/${KEY}`, source: "x" }]) });
    await listPublishers();
    fetchMock.mockRejectedValue(new Error("down"));
    await disconnectPublishers(KEY);
    const logged = JSON.stringify([mockLogger.info.mock.calls, mockLogger.warn.mock.calls, mockLogger.debug.mock.calls]);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(SECRET);
  });
});
