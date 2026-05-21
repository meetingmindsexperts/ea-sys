/**
 * Load the help-chat knowledge base: `public/user-guide.html` stripped
 * to plain text. Module-scope cached — one disk read per server
 * process.
 *
 * Production: `public/user-guide.html` is bundled into the Docker
 * image at build time (Next.js standalone output copies `public/`),
 * so the file never changes between deploys. No hot-reload story
 * needed.
 *
 * Dev: a dev-server restart picks up guide edits. Adding a file
 * watcher would be overkill for how rarely the guide changes.
 *
 * Failure mode: if the file is missing at first call, we throw with a
 * useful message. Fail fast — better to crash on the first chatbot
 * request than to silently serve an empty KB.
 */

import fs from "node:fs";
import path from "node:path";

const GUIDE_RELATIVE_PATH = "public/user-guide.html";

let _cached: string | null = null;

export function getGuideContent(): string {
  if (_cached !== null) return _cached;
  const guidePath = path.join(process.cwd(), GUIDE_RELATIVE_PATH);
  let html: string;
  try {
    html = fs.readFileSync(guidePath, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read help-chat KB at ${guidePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  _cached = stripHtml(html);
  return _cached;
}

/**
 * Strip HTML to plain text for LLM system-prompt content.
 *
 * Rules (each one has a unit test pinning it):
 *   1. `<script>…</script>` and `<style>…</style>` BODIES removed
 *      entirely. The model doesn't need them and they bloat the
 *      cache; more importantly, script bodies appearing as text in
 *      the prompt is a quiet prompt-injection surface.
 *   2. `<!-- … -->` HTML comments removed (same reasoning).
 *   3. Common HTML entities decoded — both named (`&amp;`, `&nbsp;`,
 *      `&copy;`, smart quotes, em/en dash, ellipsis) and numeric
 *      (`&#39;`, `&#x2014;`).
 *   4. Remaining tags replaced with a single space (NOT empty) so
 *      adjacent inline elements like `<b>foo</b><i>bar</i>` become
 *      `foo bar`, not `foobar`.
 *   5. Multiple whitespace collapsed to one space; trim.
 *
 * Exported for unit testing — production callers use
 * `getGuideContent()`.
 */
export function stripHtml(html: string): string {
  let out = html;

  // Order matters — kill scripts/styles + comments BEFORE tag stripping
  // so their bodies don't leak through.
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  out = out.replace(/<!--[\s\S]*?-->/g, " ");

  // Numeric character refs: decimal + hex.
  out = out.replace(/&#(\d+);/g, (_m, code) =>
    String.fromCharCode(Number(code)),
  );
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );

  // Named entities the guide is likely to contain.
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    copy: "©",
    reg: "®",
    trade: "™",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    ldquo: "“",
    rdquo: "”",
    lsquo: "‘",
    rsquo: "’",
  };
  out = out.replace(/&(\w+);/g, (match, name) => named[name] ?? match);

  // Tag strip — single space, see rule 4.
  out = out.replace(/<[^>]+>/g, " ");

  // Whitespace normalize.
  out = out.replace(/\s+/g, " ").trim();

  return out;
}

/**
 * Reset the module cache. Test-only — use this in `beforeEach` to
 * force `getGuideContent()` to re-read the file (after swapping
 * `fs.readFileSync` mocks, for instance). Named with `__…ForTests` so
 * a production import looks obviously wrong.
 */
export function __resetGuideCacheForTests(): void {
  _cached = null;
}
