/**
 * Every React Query fetch layer must throw an error carrying the HTTP status.
 *
 * WHY THIS GUARD EXISTS. `QueryCache.onError` in src/components/providers.tsx
 * is the one place every client query and mutation failure lands, and it reads
 * `httpStatusOf(error)` to tell an expired session from a real fault. An error
 * thrown WITHOUT a status is invisible to it: the redirect never fires and a
 * stale tab renders empty lists instead of sending the person to sign in.
 *
 * That is not hypothetical twice over. It was found in the CRM in Aug 2026 and
 * fixed there; then the HR module, written a week later, reintroduced it in
 * eight throw sites at once and production logged a burst of
 * `hr/*:unauthorized` with nobody being told they were logged out. The same
 * sweep found one survivor in the CRM's own file (the deal-document upload,
 * hand-rolled because it posts multipart FormData).
 *
 * The general shape, worth naming: a cross-cutting handler that reads a
 * CONVENTION only protects code that happens to follow the convention, and
 * nothing forces a new module to. `session-expiry.ts` even says so in its own
 * comment, listing three fetchers and warning that a check recognising only one
 * "silently misses the others" — and was then missed by a fourth. A comment
 * cannot enforce; this test can.
 *
 * The list GROWS as fetch layers are added and must never shrink to make the
 * suite pass: removing an entry is the regression.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { ApiError } from "@/lib/api-fetch";
import { httpStatusOf } from "@/lib/session-expiry";
import { get, send } from "@/hr/hooks/use-hr-api";

/**
 * The modules whose thrown errors reach `QueryCache.onError`: the shared
 * helper, and every hook layer that builds a request by hand.
 */
const QUERY_FETCH_LAYERS = [
  "src/lib/api-fetch.ts",
  "src/hooks/use-api.ts",
  "src/crm/hooks/use-crm-api.ts",
  "src/hr/hooks/use-hr-api.ts",
  "src/app/(dashboard)/invoices/invoices-client.tsx",
] as const;

/**
 * Read a source file with comments stripped. The guard is about CODE — a
 * comment explaining why bare `new Error(` is banned must not itself fail the
 * build for containing the words. Same reasoning as
 * scripts/check-tenant-als.sh and session-config.test.ts.
 */
const readCode = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("query fetch layers carry the HTTP status", () => {
  it.each(QUERY_FETCH_LAYERS)("%s exists", (rel) => {
    // A renamed or deleted layer must break loudly rather than silently drop
    // out of coverage.
    expect(existsSync(join(process.cwd(), rel))).toBe(true);
  });

  it.each(QUERY_FETCH_LAYERS)("%s throws no status-less Error", (rel) => {
    const code = readCode(rel);
    // `new Error(...)` carries no status. Every throw in these files must be an
    // ApiError, or a hand-rolled error that assigns `.status` before throwing
    // (invoices-client does the latter, deliberately).
    expect(code).not.toMatch(/new Error\(/);
  });

  it("no hook fetch layer is missing from the list", () => {
    // The list above is hand-maintained, so its real failure mode is not a
    // wrong entry but a MISSING one: somebody adds src/<module>/hooks/
    // use-<module>-api.ts, never registers it, and the guard passes while the
    // new module repeats the bug. Every file matching the house naming
    // convention must be listed. Registering a new layer is one line; being
    // silently uncovered is how this happened twice.
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          walk(rel);
        } else if (/^use-[a-z-]*api\.ts$/.test(entry.name) && dir.endsWith("/hooks")) {
          found.push(rel);
        }
      }
    };
    walk("src");
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(QUERY_FETCH_LAYERS).toContain(f);
  });

  it("the shared ApiError is readable by the session-expiry handler", () => {
    // The two halves of the contract meeting: what the fetchers throw, and what
    // the handler reads. If either side moved, this fails.
    expect(httpStatusOf(new ApiError("nope", 401, { error: "nope" }))).toBe(401);
  });

  it("a bare Error is NOT readable, which is the whole point", () => {
    expect(httpStatusOf(new Error("nope"))).toBeUndefined();
  });
});

describe("HR fetch helpers", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const respond = (status: number, body: unknown) =>
    fetchMock.mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });

  it("get() carries the status on a 401 so the redirect can fire", async () => {
    respond(401, { error: "Unauthorized" });
    // This is the exact production line: hr/summary:unauthorized. Before the
    // fix it threw a bare Error and the person saw an empty page.
    await expect(get("/api/hr/summary")).rejects.toMatchObject({ status: 401 });
  });

  it("get() rewords a 403 but keeps the status", async () => {
    respond(403, { error: "Forbidden" });
    const err = (await get("/api/hr/summary").catch((e) => e)) as ApiError;
    expect(err.status).toBe(403);
    expect(err.message).toContain("do not have access to the HR module");
  });

  it("get() passes the server's message through on other failures", async () => {
    respond(400, { error: "Invalid year" });
    await expect(get("/api/hr/summary")).rejects.toMatchObject({
      status: 400,
      message: "Invalid year",
    });
  });

  it("send() carries status and the service's code", async () => {
    respond(409, { error: "Over the limit", code: "SICK_FULL_TIER_EXCEEDED", used: 10 });
    const err = (await send("/api/hr/attendance", "PUT", {}).catch((e) => e)) as ApiError;
    expect(err.status).toBe(409);
    expect(err.code).toBe("SICK_FULL_TIER_EXCEEDED");
    // The route SPREADS meta at the top level, so the grid reads it from data.
    expect(err.data?.used).toBe(10);
  });

  it("send() uses the caller's fallback only when the body has no error field", async () => {
    // What an unhandled 500 looks like: Next answers HTML, the parse yields {}.
    respond(500, {});
    await expect(
      send("/api/hr/attendance-rules", "POST", {}, "Could not save that rule."),
    ).rejects.toMatchObject({ status: 500, message: "Could not save that rule." });
  });

  it("send() prefers the server's message over the fallback", async () => {
    respond(400, { error: "That rule overlaps another." });
    await expect(
      send("/api/hr/attendance-rules", "POST", {}, "Could not save that rule."),
    ).rejects.toMatchObject({ message: "That rule overlaps another." });
  });

  it("send() omits the body and content-type on a bodyless DELETE", async () => {
    respond(200, { ok: true });
    await send("/api/hr/holidays/abc", "DELETE");
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });
});
