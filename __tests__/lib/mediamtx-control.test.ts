/**
 * The client for MediaMTX's control API (Nov 12, 2026, external streams step
 * 3). Not verified against a running server when written, so what is pinned
 * here is that it FAILS SAFE: an answer it cannot read is never "nobody is
 * publishing", and only an exactly matching path is ever disconnected.
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
} from "@/lib/webinar/mediamtx-control";

const SECRET = "s".repeat(40);
const KEY = "0123456789abcdef0123456789abcdef";
const fetchMock = vi.fn();
const json = (status: number, body: unknown) => ({ status, json: async () => body });
const conn = (id: string, path: string, state = "publish") => ({ id, state, path, remoteAddr: "203.0.113.9:5000" });
const page = (items: unknown[], pageCount = 1) => json(200, { pageCount, itemCount: items.length, items });

/** Answers by URL: the two list families and the kick. */
function serve(routes: { rtmp?: unknown; rtmps?: unknown; kick?: (id: string) => unknown }) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/v3/rtmpconns/list")) return routes.rtmp ?? page([]);
    if (url.includes("/v3/rtmpsconns/list")) return routes.rtmps ?? page([]);
    const kick = /\/v3\/rtmps?conns\/kick\/(.+)$/.exec(url);
    if (kick) return routes.kick ? routes.kick(decodeURIComponent(kick[1])) : json(200, {});
    return json(404, {});
  });
}

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

describe("listPublishers", () => {
  it("sends our user and the secret as HTTP Basic, and returns only connections that are publishing", async () => {
    serve({ rtmp: page([conn("a", `live/${KEY}`), conn("b", "live/other", "read"), conn("c", "live/other", "idle")]) });
    const res = await listPublishers();
    expect(res).toEqual({ ok: true, publishers: [{ id: "a", family: "rtmpconns", path: `live/${KEY}`, remoteAddr: "203.0.113.9:5000" }] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://ea-sys-mediamtx:9997/v3/rtmpconns/list?itemsPerPage=100&page=0");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from(`ea-sys:${SECRET}`).toString("base64")}`);
  });

  it("reads every page", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("rtmpsconns")) return page([]);
      return url.endsWith("page=0") ? page([conn("a", "live/x")], 2) : page([conn("b", "live/y")], 2);
    });
    const res = await listPublishers();
    expect(res.ok && res.publishers.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("includes RTMPS publishers, and an RTMPS list that does not answer is read as none, not as a failure", async () => {
    serve({ rtmp: page([conn("a", "live/x")]), rtmps: page([conn("s", "live/y")]) });
    const both = await listPublishers();
    expect(both.ok && both.publishers.map((p) => `${p.family}:${p.id}`)).toEqual(["rtmpconns:a", "rtmpsconns:s"]);
    serve({ rtmp: page([conn("a", "live/x")]), rtmps: json(404, {}) });
    const one = await listPublishers();
    expect(one.ok && one.publishers.map((p) => p.id)).toEqual(["a"]);
  });

  it("an answer it cannot read is BAD_ANSWER, never an empty list", async () => {
    for (const bad of [json(200, null), json(200, { items: "x" }), json(200, { pageCount: 1 }), json(500, {}), json(404, {})]) {
      serve({ rtmp: bad });
      expect(await listPublishers()).toEqual({ ok: false, code: "BAD_ANSWER" });
    }
  });

  it("refused (the webhook said no) and unreachable are told apart, and logged", async () => {
    serve({ rtmp: json(401, {}) });
    expect(await listPublishers()).toEqual({ ok: false, code: "REFUSED" });
    fetchMock.mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    expect(await listPublishers()).toEqual({ ok: false, code: "UNREACHABLE" });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "ECONNREFUSED" }), "mediamtx-control:unreachable");
  });
});

describe("kickPublisher and disconnectPublishers", () => {
  const publisher = { id: "a", family: "rtmpconns" as const, path: `live/${KEY}`, remoteAddr: "" };

  it("a kick that succeeds, or finds the connection already gone, is done; anything else is not", async () => {
    serve({ kick: () => json(200, {}) });
    expect(await kickPublisher(publisher)).toBe(true);
    serve({ kick: () => json(404, {}) });
    expect(await kickPublisher(publisher)).toBe(true);
    serve({ kick: () => json(500, {}) });
    expect(await kickPublisher(publisher)).toBe(false);
    fetchMock.mockRejectedValue(new Error("down"));
    expect(await kickPublisher(publisher)).toBe(false);
  });

  it("disconnects every publisher on exactly this key's path, on the right family, and nobody else", async () => {
    const kicked: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v3/rtmpconns/list")) {
        return page([conn("mine", `live/${KEY}`), conn("other", `live/${"f".repeat(32)}`), conn("prefix", `live/${KEY}x`), conn("reader", `live/${KEY}`, "read")]);
      }
      if (url.includes("/v3/rtmpsconns/list")) return page([conn("mine-s", `live/${KEY}`)]);
      kicked.push(url.replace("http://ea-sys-mediamtx:9997", ""));
      return json(200, {});
    });
    expect(await disconnectPublishers(KEY)).toEqual({ ok: true, disconnected: 2 });
    expect(kicked).toEqual(["/v3/rtmpconns/kick/mine", "/v3/rtmpsconns/kick/mine-s"]);
  });

  it("nobody publishing: zero, and nothing is kicked", async () => {
    expect(await disconnectPublishers(KEY)).toEqual({ ok: true, disconnected: 0 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/kick/"))).toBe(false);
  });

  it("a list that fails, or a kick that does not happen, is a failure the caller can show", async () => {
    serve({ rtmp: json(200, null) });
    expect(await disconnectPublishers(KEY)).toMatchObject({ ok: false, code: "BAD_ANSWER" });
    serve({ rtmp: page([conn("mine", `live/${KEY}`)]), kick: () => json(500, {}) });
    expect(await disconnectPublishers(KEY)).toMatchObject({ ok: false, code: "REFUSED" });
  });

  it("no log line carries the stream key or the secret", async () => {
    serve({ rtmp: page([conn("mine", `live/${KEY}`)]), kick: () => json(500, {}) });
    await disconnectPublishers(KEY);
    fetchMock.mockRejectedValue(new Error("down"));
    await disconnectPublishers(KEY);
    const logged = JSON.stringify([mockLogger.info.mock.calls, mockLogger.warn.mock.calls, mockLogger.debug.mock.calls]);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(SECRET);
  });
});
