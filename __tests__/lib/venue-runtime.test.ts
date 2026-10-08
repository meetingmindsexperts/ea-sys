/**
 * public/venue-runtime.js: the stand-in for the host runtime the vendor's venue
 * was written against. Driven here exactly as the vendor's team.js drives it,
 * against a fake /api/venue server, so a path the vendor reads but the shim
 * does not answer shows up as a failure (the Reports tab was always empty
 * until Oct 8, 2026, because the bare `reports` collection returned nothing).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(path.join(process.cwd(), "public/venue-runtime.js"), "utf8");

type Doc = Record<string, unknown>;
type Query = { limit: (n: number) => Query; get: () => Promise<{ docs: { data: () => Doc }[] }> };
type Db = { collection: (path: string) => Query };
type Claude = { use: (name: string) => Promise<Db> };

function boot(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const window: Record<string, unknown> = { EHC_VENUE: { api: "/api/venue/e1", userId: "u-1", name: "Wren", team: true } };
  const fetch = async (url: string, init: { method: string }) => {
    calls.push(`${init.method} ${url}`);
    const body = routes[`${init.method} ${url}`];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
  };
  new Function("window", "fetch", "document", "URL", SRC)(window, fetch, {}, URL);
  return { claude: window.claude as Claude, calls };
}

// team.js: fetchAll(col) = collection(col).limit(2000).get() -> docs.map(d => d.data())
const fetchAll = async (db: Db, col: string): Promise<Doc[]> => (await db.collection(col).limit(2000).get()).docs.map((d) => d.data());

describe("venue runtime", () => {
  it("gives the team's Reports tab every stored report, as team.js reads them", async () => {
    const items = [{ reason: "Harassment", at: 2 }, { reason: "Spam", at: 1 }];
    const { claude } = boot({ "GET /api/venue/e1/reports": { reports: [{ reporterId: "u-2", item: items[0] }, { reporterId: "u-3", item: items[1] }] } });
    const db = await claude.use("db");
    const docs = await fetchAll(db, "reports");
    // drawReports: items = docs.flatMap(d => d.items), then a per-reporter fetch only for docs with a uid
    expect(docs.flatMap((d) => (Array.isArray(d.items) ? d.items : []))).toEqual(items);
    expect(docs.some((d) => typeof d.uid === "string")).toBe(false);
  });

  it("lists one reporter's own reports from the same single read", async () => {
    const { claude, calls } = boot({ "GET /api/venue/e1/reports": { reports: [{ reporterId: "u-2", item: { reason: "Spam" } }, { reporterId: "u-3", item: { reason: "Other" } }] } });
    const db = await claude.use("db");
    expect(await fetchAll(db, "reports/u-2/items")).toEqual([{ reason: "Spam" }]);
    await fetchAll(db, "reports");
    expect(calls.filter((c) => c.endsWith("/reports"))).toHaveLength(1);
  });

  it("gives the Activity tab everyone's activity", async () => {
    const { claude } = boot({ "GET /api/venue/e1/activity": { activity: [{ uid: "u-1", sessions: 2 }] } });
    expect(await fetchAll(await claude.use("db"), "analytics")).toEqual([{ uid: "u-1", sessions: 2 }]);
  });

  it("turns a 403 into the vendor's permission_denied", async () => {
    const window: Record<string, unknown> = { EHC_VENUE: { api: "/api/venue/e1", userId: "u-1", name: "", team: false } };
    const fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
    new Function("window", "fetch", "document", "URL", SRC)(window, fetch, {}, URL);
    const db = await (window.claude as Claude).use("db");
    await expect(db.collection("analytics").get()).rejects.toEqual({ code: "permission_denied" });
  });

  it("tries a failed read again on the next use, instead of failing until a reload (review L6)", async () => {
    let n = 0;
    const window: Record<string, unknown> = { EHC_VENUE: { api: "/api/venue/e1", userId: "u-1", name: "", team: true } };
    const fetch = async () => (++n === 1 ? { ok: false, status: 502, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ filter: { on: true }, screens: null }) });
    new Function("window", "fetch", "document", "URL", SRC)(window, fetch, {}, URL);
    const db = await (window.claude as Claude).use("db") as unknown as { doc: (p: string) => { get: () => Promise<{ exists: boolean; data: () => Doc }> } };
    await expect(db.doc("config/filter").get()).rejects.toMatchObject({ status: 502 });
    expect((await db.doc("config/filter").get()).data()).toEqual({ on: true });
  });

  it("sends a small save with keepalive so it outlives the page, and a large one the ordinary way (review L7)", async () => {
    const seen: { method: string; keepalive: boolean }[] = [];
    const window: Record<string, unknown> = { EHC_VENUE: { api: "/api/venue/e1", userId: "u-1", name: "", team: false } };
    const fetch = async (_u: string, init: { method: string; keepalive: boolean }) => { seen.push({ method: init.method, keepalive: init.keepalive }); return { ok: true, status: 200, json: async () => ({}) }; };
    new Function("window", "fetch", "document", "URL", SRC)(window, fetch, {}, URL);
    const db = await (window.claude as Claude).use("db") as unknown as { doc: (p: string) => { get: () => Promise<unknown>; set: (d: unknown) => Promise<unknown> } };
    await db.doc("analytics/u-1").set({ sessions: 1 });
    await db.doc("analytics/u-1").set({ big: "x".repeat(70_000) });
    await db.doc("analytics/u-1").get();
    expect(seen).toEqual([{ method: "PUT", keepalive: true }, { method: "PUT", keepalive: false }, { method: "GET", keepalive: false }]);
  });
});
