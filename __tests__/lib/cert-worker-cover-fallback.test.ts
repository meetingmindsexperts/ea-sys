/**
 * The Issue worker's cover-email fallback (a run with no snapshot, e.g. a
 * survey auto-issue run) must use the shared resolver, not a hand-written
 * copy of the rule, and must not reach for a per-template cover (removed
 * Sep 18, 2026). Pinned at SOURCE level: the send phase needs a full run
 * fixture to exercise, and the rule itself is unit-tested through
 * resolveDefaultCoverEmail in certificates-deliver.test.ts. Comments are
 * stripped so prose cannot satisfy or break the check.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join(process.cwd(), "src/lib/certificates/issue-worker.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("issue-worker cover fallback", () => {
  it("resolves the fallback through resolveDefaultCoverEmail by run type alone", () => {
    expect(source).toMatch(/await resolveDefaultCoverEmail\(\s*eventId,\s*bundleCount,\s*runRow\.type,?\s*\)/);
  });

  it("never reads a per-template cover off the run's template", () => {
    expect(source).not.toMatch(/certificateTemplate: \{ select: \{[^}]*emailSubject/);
  });

  it("does not hardcode the built-in cover text", () => {
    expect(source).not.toMatch(/defaultCoverEmailFor\(/);
    expect(source).not.toMatch(/SYSTEM_DEFAULT_(SUBJECT|BODY)/);
  });
});
