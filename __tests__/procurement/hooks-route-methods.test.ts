/**
 * Every `send(url, method)` and every `get(url)` in the module's hooks must
 * name a method the matching route file actually exports. Found the hard way on Sep 14, 2026:
 * the line-edit hook sent PUT to a route that exports PATCH, a 405 no unit
 * test could see because the hooks and the routes are tested apart.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const HOOKS = readFileSync(path.join(ROOT, "src/procurement/hooks/use-procurement-api.ts"), "utf8");

/** `send<...>("/api/procurement/...", "METHOD")` (template or plain string) and the ternary form `cond ? \`a\` : \`b\`, cond ? "M1" : "M2"`. */
function sendCalls(): { url: string; method: string }[] {
  const calls: { url: string; method: string }[] = [];
  const plain = /send<[^>]*>\(\s*[`"]([^`"]+)[`"]\s*,\s*"(GET|POST|PATCH|PUT|DELETE)"/g;
  for (const m of HOOKS.matchAll(plain)) calls.push({ url: m[1], method: m[2] });
  const ternary = /send<[^>]*>\(\s*\w+\s*\?\s*`([^`]+)`\s*:\s*`([^`]+)`\s*,\s*\w+\s*\?\s*"(GET|POST|PATCH|PUT|DELETE)"\s*:\s*"(GET|POST|PATCH|PUT|DELETE)"/g;
  for (const m of HOOKS.matchAll(ternary)) calls.push({ url: m[1], method: m[3] }, { url: m[2], method: m[4] });
  const reads = /get<[^>]*>\(\s*[`"]([^`"]+)[`"]/g;
  for (const m of HOOKS.matchAll(reads)) calls.push({ url: m[1], method: "GET" });
  return calls;
}

/** `/api/procurement/budgets/${budgetId}/lines/${lineId}` -> src/app/api/procurement/budgets/[budgetId]/lines/[lineId]/route.ts */
function routeFileFor(url: string): string {
  // A query string, and a nested template a read builds its query with
  // (`/budgets${q ? `?${q}` : ""}` captures up to the inner backtick), are
  // not path segments.
  const segments = url.replace(/\?.*$/, "").replace(/\$\{[^}]*$/, "").split("/").filter(Boolean).map((s) => s.replace(/^\$\{(\w+)\}$/, "[$1]"));
  return path.join(ROOT, "src/app", ...segments, "route.ts");
}

describe("procurement hooks call methods their routes export", () => {
  const calls = sendCalls();
  it("finds the module's mutations", () => {
    expect(calls.length).toBeGreaterThanOrEqual(12);
  });
  for (const c of calls) {
    it(`${c.method} ${c.url}`, () => {
      const file = routeFileFor(c.url);
      expect(existsSync(file), `no route file at ${path.relative(ROOT, file)}`).toBe(true);
      const exported = [...readFileSync(file, "utf8").matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)].map((m) => m[1]);
      expect(exported, `${path.relative(ROOT, file)} exports ${exported.join(", ")}`).toContain(c.method);
    });
  }
});
