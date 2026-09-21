/**
 * Shared scanning primitives for the API-route CI gates.
 *
 * Extracted (Sep 21, 2026) when the second route gate arrived. Both
 * check-route-auth.mjs ("does every handler establish identity?") and
 * check-request-validation.mjs ("does every handler validate its body?") need
 * the same three things: find the route files, remove comments so prose cannot
 * satisfy a rule, and cut a file into its individual HTTP handlers.
 *
 * They live here rather than being typed twice because these gates exist to
 * catch drift, and two hand-maintained copies of a scanner is itself drift.
 * The per-handler split in particular is not a detail worth re-deriving: a
 * file-level check passes a route whose GET is compliant and whose
 * newly-added DELETE is not, which is the likeliest real-world case, and
 * check-tenant-als.sh already learned that the hard way when its per-file
 * first version PASSED a deliberately injected violation.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** HTTP methods Next.js treats as route handlers. */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/**
 * Every `route.ts` under `dir`, recursively.
 */
export function walkRoutes(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walkRoutes(p, out);
    else if (entry === "route.ts") out.push(p);
  }
  return out;
}

/**
 * Strip comments, so prose ABOUT a rule cannot satisfy the rule.
 *
 * Not cosmetic: check-guard-route.sh's own header records its first version
 * failing on exactly this, and a gate that reads its own explanatory comment
 * as evidence is worse than no gate.
 */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Split a file into its exported HTTP handlers.
 * Returns [{ method, body }]. A handler's body runs to the next top-level
 * export, or to EOF for the last one.
 */
export function splitHandlers(code) {
  const re = new RegExp(
    String.raw`export\s+(?:async\s+)?function\s+(${HTTP_METHODS.join("|")})\b`,
    "g"
  );
  const starts = [...code.matchAll(re)].map((m) => ({ method: m[1], index: m.index }));
  return starts.map((s, i) => ({
    method: s.method,
    body: code.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : code.length),
  }));
}
