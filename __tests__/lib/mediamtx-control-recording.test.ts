/**
 * Telling MediaMTX to record one stream (Nov 24, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md, step 1). Like the rest of the control
 * client this was written from MediaMTX 1.17.1's source and not against a
 * running server, so what is pinned is that it FAILS SAFE, that calling it
 * twice changes nothing, and above all WHAT IS SENT: a setting that carries
 * anything but `record` makes MediaMTX disconnect the sender mid-webinar.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const { mockLogger } = vi.hoisted(() => ({ mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));

import { clearPathRecording, deleteRecordingPiece, pathRecording, setPathRecording } from "@/lib/webinar/mediamtx-control";

const SECRET = "s".repeat(40);
const KEY = "0123456789abcdef0123456789abcdef";
const BASE = "http://ea-sys-mediamtx:9997";
const fetchMock = vi.fn();
const json = (status: number, body: unknown) => ({ status, json: async () => body });
const notFound = () => json(404, { status: "error", error: "path configuration not found" });
/** A path's own setting as MediaMTX returns it: the whole configuration, of which only `record` is read. */
const setting = (record: boolean) => json(200, { name: `live/${KEY}`, source: "publisher", record, recordFormat: "mpegts" });

interface Call {
  method: string;
  path: string;
  body: unknown;
}
const calls = (): Call[] =>
  fetchMock.mock.calls.map(([url, init]) => ({
    method: (init as { method: string }).method,
    path: String(url).replace(BASE, ""),
    body: (init as { body?: string }).body ? JSON.parse((init as { body: string }).body) : undefined,
  }));

/** Answers the read with `current`, and every change with `change` (default: done). */
function serve(current: unknown, change: unknown = json(200, { status: "ok" })) {
  fetchMock.mockImplementation(async (url: string, init: { method: string }) => (init.method === "GET" ? current : change));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  process.env.MEDIAMTX_API_URL = `${BASE}/`;
  process.env.MEDIAMTX_API_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.MEDIAMTX_API_URL;
  delete process.env.MEDIAMTX_API_SECRET;
});

describe("pathRecording", () => {
  it("reads on, off, and no setting of its own", async () => {
    serve(setting(true));
    expect(await pathRecording(KEY)).toEqual({ ok: true, recording: "on" });
    serve(setting(false));
    expect(await pathRecording(KEY)).toEqual({ ok: true, recording: "off" });
    serve(notFound());
    expect(await pathRecording(KEY)).toEqual({ ok: true, recording: "none" });
    expect(calls()[0]).toMatchObject({ method: "GET", path: `/v3/config/paths/get/live/${KEY}` });
  });

  it("a bare 404 is some other server, never 'no setting'", async () => {
    serve(json(404, null));
    expect(await pathRecording(KEY)).toEqual({ ok: false, code: "BAD_ANSWER" });
  });

  it("an answer without a true or false `record` is not understood, and said", async () => {
    serve(json(200, { name: `live/${KEY}` }));
    expect(await pathRecording(KEY)).toEqual({ ok: false, code: "BAD_ANSWER" });
    expect(mockLogger.warn).toHaveBeenCalledWith({ status: 200 }, "mediamtx-control:recording-setting-not-understood");
  });

  it("REFUSED when our webhook turns the secret down", async () => {
    serve(json(401, null));
    expect(await pathRecording(KEY)).toEqual({ ok: false, code: "REFUSED" });
  });

  it("UNREACHABLE when the stream server does not answer", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    expect(await pathRecording(KEY)).toEqual({ ok: false, code: "UNREACHABLE" });
  });
});

describe("setPathRecording", () => {
  it("a stream with no setting gets one that says record, and NOTHING else", async () => {
    serve(notFound());
    expect(await setPathRecording(KEY, true)).toEqual({ ok: true, changed: true });
    const [, change] = calls();
    expect(change).toEqual({ method: "POST", path: `/v3/config/paths/add/live/${KEY}`, body: { record: true } });
  });

  it("an existing setting is switched in place, again with `record` alone", async () => {
    serve(setting(true));
    expect(await setPathRecording(KEY, false)).toEqual({ ok: true, changed: true });
    expect(calls()[1]).toEqual({ method: "PATCH", path: `/v3/config/paths/patch/live/${KEY}`, body: { record: false } });
    serve(setting(false));
    expect(await setPathRecording(KEY, true)).toEqual({ ok: true, changed: true });
    expect(calls()[3]).toEqual({ method: "PATCH", path: `/v3/config/paths/patch/live/${KEY}`, body: { record: true } });
  });

  // The pin behind the comment in mediamtx-control.ts: any other field in the setting disconnects the sender.
  it("every change it ever sends has exactly one field", async () => {
    for (const [current, record] of [
      [notFound(), true],
      [setting(true), false],
      [setting(false), true],
    ] as const) {
      fetchMock.mockClear();
      serve(current);
      await setPathRecording(KEY, record);
      const change = calls().find((c) => c.method !== "GET");
      expect(Object.keys(change?.body as object)).toEqual(["record"]);
    }
  });

  it("already as asked: nothing is sent (the minute sweep calls this every minute)", async () => {
    serve(setting(true));
    expect(await setPathRecording(KEY, true)).toEqual({ ok: true, changed: false });
    serve(setting(false));
    expect(await setPathRecording(KEY, false)).toEqual({ ok: true, changed: false });
    expect(calls().every((c) => c.method === "GET")).toBe(true);
  });

  it("stop on a stream with no setting is already true: no setting is made just to say no", async () => {
    serve(notFound());
    expect(await setPathRecording(KEY, false)).toEqual({ ok: true, changed: false });
    expect(calls()).toHaveLength(1);
  });

  it("when the state cannot be read, nothing is changed", async () => {
    serve(json(500, null));
    expect(await setPathRecording(KEY, true)).toEqual({ ok: false, code: "BAD_ANSWER" });
    expect(calls()).toHaveLength(1);
  });

  it("a change MediaMTX turns down is REFUSED and logged, never reported as done", async () => {
    serve(notFound(), json(400, { status: "error", error: "invalid configuration" }));
    expect(await setPathRecording(KEY, true)).toEqual({ ok: false, code: "REFUSED" });
    expect(mockLogger.warn).toHaveBeenCalledWith({ status: 400, verb: "add" }, "mediamtx-control:recording-change-refused");
  });

  it("a change answered by something that is not MediaMTX is BAD_ANSWER", async () => {
    serve(setting(false), json(502, null));
    expect(await setPathRecording(KEY, true)).toEqual({ ok: false, code: "BAD_ANSWER" });
  });

  it("not set up: nothing is called", async () => {
    delete process.env.MEDIAMTX_API_URL;
    expect(await setPathRecording(KEY, true)).toEqual({ ok: false, code: "NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never logs the stream key", async () => {
    serve(notFound(), json(400, { status: "error", error: "no" }));
    await setPathRecording(KEY, true);
    serve(json(200, {}));
    await pathRecording(KEY);
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(KEY);
  });
});

describe("clearPathRecording", () => {
  it("removes the stream's own setting", async () => {
    serve(null, json(200, { status: "ok" }));
    expect(await clearPathRecording(KEY)).toEqual({ ok: true, changed: true });
    expect(calls()[0]).toEqual({ method: "DELETE", path: `/v3/config/paths/delete/live/${KEY}`, body: undefined });
  });

  it("already gone is the outcome wanted", async () => {
    serve(null, notFound());
    expect(await clearPathRecording(KEY)).toEqual({ ok: true, changed: false });
  });

  it("a bare 404 is some other server: not counted as cleared", async () => {
    serve(null, json(404, null));
    expect(await clearPathRecording(KEY)).toEqual({ ok: false, code: "BAD_ANSWER" });
  });
});

describe("deleteRecordingPiece", () => {
  const START = "2026-11-24T09:24:56.718063Z";

  it("asks MediaMTX to delete the piece by its path and exact start", async () => {
    serve(null, json(200, { status: "ok" }));
    expect(await deleteRecordingPiece(KEY, START)).toEqual({ ok: true, changed: true });
    const [call] = calls();
    expect(call.method).toBe("DELETE");
    const url = new URL(BASE + call.path);
    expect(url.pathname).toBe("/v3/recordings/deletesegment");
    expect(url.searchParams.get("path")).toBe(`live/${KEY}`);
    expect(url.searchParams.get("start")).toBe(START);
  });

  // What MediaMTX 1.17.1 answered on the throwaway server for a piece already gone.
  it("already gone is the outcome wanted", async () => {
    serve(null, json(400, { status: "error", error: `remove /recordings/live/${KEY}/1795512296-718063.ts: no such file or directory` }));
    expect(await deleteRecordingPiece(KEY, START)).toEqual({ ok: true, changed: false });
  });

  it("any other refusal is REFUSED, logged without the key", async () => {
    serve(null, json(400, { status: "error", error: "invalid path name" }));
    expect(await deleteRecordingPiece(KEY, START)).toEqual({ ok: false, code: "REFUSED" });
    expect(mockLogger.warn).toHaveBeenCalledWith({ status: 400 }, "mediamtx-control:piece-delete-refused");
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(KEY);
  });

  it("an answer that is not MediaMTX's is BAD_ANSWER, never done", async () => {
    serve(null, json(502, null));
    expect(await deleteRecordingPiece(KEY, START)).toEqual({ ok: false, code: "BAD_ANSWER" });
  });
});

/**
 * Why sending `record` alone is enough (review of 7563027f7). A setting made
 * through the API is built from MediaMTX's `pathDefaults`, and a live stream is
 * on the general `all` entry. The sender stays connected only if those two
 * differ in recording fields and nothing else, so `all` must itself add nothing
 * to the defaults. `source: publisher` IS the default. Any other line under
 * `paths: all:` would make every Start disconnect the partner mid-webinar: the
 * recording defaults of the plan go under `pathDefaults:`, never here.
 */
describe("mediamtx.yml", () => {
  const yml = readFileSync(path.join(process.cwd(), "mediamtx.yml"), "utf8");
  const lines = yml.split("\n").map((l) => l.replace(/\s+#.*$/, "").trimEnd());

  it("the general `all` entry holds nothing but the default source", () => {
    const start = lines.findIndex((l) => l === "paths:");
    expect(start).toBeGreaterThan(-1);
    const block: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      if (!/^\s/.test(line)) break;
      block.push(line);
    }
    expect(block).toEqual(["  all:", "    source: publisher"]);
  });

  // Recording is off unless our app switches it on for one stream: a default of "yes" would record every webinar.
  it("records nothing by default, into the buffer folder, in named-by-Unix-time pieces", () => {
    const start = lines.findIndex((l) => l === "pathDefaults:");
    expect(start).toBeGreaterThan(-1);
    const block = lines.slice(start + 1, start + 12).filter((l) => /^\s+\S/.test(l)).map((l) => l.trim());
    expect(block).toContain("record: no");
    expect(block).toContain("recordPath: /recordings/%path/%s-%f");
    expect(block).toContain("recordFormat: mpegts");
    expect(block.some((l) => /^recordDeleteAfter: \d+h$/.test(l))).toBe(true);
  });

  it("the control API stays behind our webhook: `api` is never excluded from the check", () => {
    const start = lines.findIndex((l) => l === "authHTTPExclude:");
    const excluded = lines.slice(start + 1, start + 8).filter((l) => /^\s+- action:/.test(l)).map((l) => l.trim());
    expect(excluded).not.toContain("- action: api");
  });
});
