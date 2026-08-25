/**
 * Setup hub: every card must have a status entry.
 *
 * WHY THIS EXISTS. On Aug 25, 2026 a Travel Grants card was added to
 * SETUP_CARDS without a matching key in the `statuses` map. `StatusPill` then
 * dereferenced `undefined` and the WHOLE Setup page died with a Server
 * Components render error, in production.
 *
 * Nothing caught it, and each miss is worth understanding:
 *   - tsc could not: `noUncheckedIndexedAccess` is off, so indexing a
 *     `Record<string, SetupStatus>` is typed as always present.
 *   - `next build` could not: the page is dynamic, so it is never rendered at
 *     build time.
 *   - the unit suite could not: there was no test that read the page at all.
 *
 * So this is a SOURCE-level guard, the same shape as the session-config and
 * datetime-local gates: it reads the file and compares the two lists. It is
 * crude on purpose. A render test would need the whole Prisma + auth stack
 * stubbed, and would then be testing the stub.
 *
 * The runtime guard is separate and belongs in the page: StatusPill treats a
 * missing entry as "unavailable". Both are wanted. This test says "you forgot
 * one"; the guard says "and it will not take the page down while you fix it".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(process.cwd(), "src/app/(dashboard)/events/[eventId]/setup/page.tsx"),
  "utf8",
);

/** Slugs declared on the cards, including the finance-only INVOICES_CARD. */
function declaredSlugs(): string[] {
  return [...SRC.matchAll(/^\s*slug:\s*"([^"]+)"/gm)].map((m) => m[1]);
}

/** Keys present in the `statuses` map literal. */
function statusKeys(): string[] {
  const start = SRC.indexOf("const statuses: StatusMap = {");
  expect(start).toBeGreaterThan(-1);
  const body = SRC.slice(start, SRC.indexOf("\n  };", start));
  return [...body.matchAll(/^\s{4}(?:"([^"]+)"|([A-Za-z][A-Za-z0-9_]*)):\s*\{/gm)].map(
    (m) => m[1] ?? m[2],
  );
}

describe("setup hub status coverage", () => {
  it("finds the cards and the status map at all", () => {
    // If these ever come back empty the regexes have gone stale and the two
    // assertions below would pass vacuously, which is worse than failing.
    expect(declaredSlugs().length).toBeGreaterThan(5);
    expect(statusKeys().length).toBeGreaterThan(5);
  });

  it("every card slug has a status entry", () => {
    const keys = new Set(statusKeys());
    const missing = declaredSlugs().filter((s) => !keys.has(s));
    expect(missing).toEqual([]);
  });

  it("no status entry is orphaned from a card", () => {
    // The mirror direction. A stale key is harmless at runtime but means the
    // map and the cards have drifted, which is how the first mistake happened.
    const slugs = new Set(declaredSlugs());
    const orphaned = statusKeys().filter((k) => !slugs.has(k));
    expect(orphaned).toEqual([]);
  });

  it("StatusPill tolerates a missing entry rather than throwing", () => {
    // The runtime half. Reverting this re-arms the outage even with the test
    // above green, because someone can add a card and run the app before the
    // suite.
    expect(SRC).toMatch(/function StatusPill\(\{ status \}: \{ status\?: SetupStatus \}\)/);
    expect(SRC).toMatch(/if \(!status \|\| status\.unavailable\)/);
  });
});
