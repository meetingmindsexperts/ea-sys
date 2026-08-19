
/**
 * Zoom credential changes leave a trail, and the trail holds no credentials.
 *
 * Written after 2026-08-19, when two people changed these values on production
 * hours apart and the only trace was a single `configuredAt` that each save
 * overwrote. "What was the SDK key before 11:50, and who changed it" was
 * unanswerable, and that value was the cause of a failed live webinar.
 *
 * The tension is that the useful trail and the dangerous one are the same
 * trail: to answer the question you need to know what the value BECAME, and an
 * audit table is read by more people than a settings page. Hence fingerprints
 * for keys, and for secrets nothing but the fact that they rotated.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(process.cwd(), "src/app/api/organization/zoom/credentials/route.ts"),
  "utf8",
);

describe("zoom credential audit", () => {
  it("records a row on save and on delete", () => {
    expect(src).toContain("UPDATE_ZOOM_CREDENTIALS");
    expect(src).toContain("DELETE_ZOOM_CREDENTIALS");
  });

  it("records a before AND after fingerprint, not just that something changed", () => {
    // "credentials were updated" would not have answered the question that
    // mattered: which key was in force at the time of the failure.
    expect(src).toContain("changed[f] = { from, to }");
  });

  it("never fingerprints a secret, only that it rotated", () => {
    expect(src).toContain("changed[f] = { rotated: true }");
    // The secret fields must not be run through the fingerprinter.
    const fingerprintedSecrets = /credentialFingerprint\([^)]*Secret/i.test(src);
    expect(fingerprintedSecrets).toBe(false);
  });

  it("truncates key fingerprints rather than storing the value", () => {
    expect(src).toContain("value.slice(0, 6)");
  });

  it("does not let a failed audit write break a successful save", () => {
    // The credentials are already persisted by this point; a 500 here would
    // report failure for work that succeeded.
    expect(src).toContain("zoom:credentials-audit-failed");
    expect(src).toContain("void db.auditLog");
  });

  it("captures the resulting sdkMode, which selects which credentials sign", () => {
    expect(src).toContain("sdkMode: cleanZoom.sdkMode");
  });
});
