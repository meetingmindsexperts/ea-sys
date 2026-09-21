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
 * Split a file into its exported HTTP handlers. Returns [{ method, body }].
 *
 * Two things the first version got wrong, both found by mutation in the
 * Sep 21, 2026 review of check-request-validation.mjs:
 *
 *   - It only recognised `export async function POST`. The arrow and alias
 *     forms (`export const POST = async (req) => …`, `export const POST = run`)
 *     were invisible, so a body read inside one was either dropped or folded
 *     into the previous handler and attributed to the wrong method.
 *
 *   - A handler's body ran to the next HTTP-handler export, so a trailing
 *     module-level helper was folded into the LAST handler and its safeParse
 *     (or its auth() call) vouched for a handler that never called it.
 *
 * A body now ends at the next column-0 declaration of ANY kind. The codebase
 * is Prettier-formatted, so column 0 is a reliable top-level marker; the
 * handler's own closing `}` is not a declaration and stays inside.
 */
const METHOD_ALT = HTTP_METHODS.join("|");
const HANDLER_START = new RegExp(
  String.raw`^export\s+(?:(?:async\s+)?function\s+(${METHOD_ALT})\b|const\s+(${METHOD_ALT})\s*=)`,
  "gm"
);
const TOP_LEVEL_DECL = /^(?:export\s|async\s+function\s|function\s|const\s|let\s|var\s|interface\s|type\s|class\s|enum\s)/gm;

export function splitHandlers(code) {
  const starts = [...code.matchAll(HANDLER_START)].map((m) => ({
    method: m[1] ?? m[2],
    index: m.index,
  }));
  return starts.map((s) => {
    // Search for the next top-level declaration from the line AFTER the
    // handler's own opening line, so its own `export` is not the match.
    const lineEnd = code.indexOf("\n", s.index);
    const from = lineEnd === -1 ? code.length : lineEnd + 1;
    TOP_LEVEL_DECL.lastIndex = from;
    const next = TOP_LEVEL_DECL.exec(code);
    const end = next ? next.index : code.length;
    return { method: s.method, body: code.slice(s.index, end) };
  });
}
