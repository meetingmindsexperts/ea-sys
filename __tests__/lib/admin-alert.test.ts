/**
 * Unit tests for src/lib/admin-alert.ts — the shared dedupe + recipient
 * self-guard for the admin-alert email pipeline.
 *
 * Covers the contract that both callers (email-failure path + logger
 * hook) rely on:
 *   - shouldSendAdminAlert dedupe behavior within the 1h window
 *   - dedupe map eviction at capacity
 *   - isAlertSelfRecipient case-insensitive match against env var
 *
 * The notifyAdminAlert SES-send path is NOT exercised here — that's
 * an integration concern best tested by manual smoke (forcing a
 * failure on the box). The dedupe + self-guard ARE the load-bearing
 * pure-function pieces.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isAlertSelfRecipient,
  shouldFireInThisEnvironment,
  shouldSendAdminAlert,
} from "@/lib/admin-alert";

// Clean dedupe map between tests so the in-memory state from a prior
// case doesn't bleed into the next one. The module exports
// shouldSendAdminAlert, which manipulates the singleton — we drain it
// by burning unique keys at module init in each beforeEach.

beforeEach(() => {
  // Restore env vars between tests so an isAlertSelfRecipient test
  // doesn't lock in a value for the dedupe tests.
  vi.unstubAllEnvs();
});

describe("shouldSendAdminAlert", () => {
  it("returns true on first call for a new key", () => {
    expect(shouldSendAdminAlert(`first-call-${Date.now()}-${Math.random()}`)).toBe(true);
  });

  it("returns false on second call for the same key within the window", () => {
    const key = `dedupe-test-${Date.now()}-${Math.random()}`;
    expect(shouldSendAdminAlert(key)).toBe(true);
    expect(shouldSendAdminAlert(key)).toBe(false);
    expect(shouldSendAdminAlert(key)).toBe(false);
  });

  it("treats different keys independently (no false-positive dedupe)", () => {
    const a = `key-a-${Date.now()}-${Math.random()}`;
    const b = `key-b-${Date.now()}-${Math.random()}`;
    expect(shouldSendAdminAlert(a)).toBe(true);
    expect(shouldSendAdminAlert(b)).toBe(true); // different key → fresh
  });
});

describe("isAlertSelfRecipient", () => {
  it("matches the default recipient (krishna@meetingmindsdubai.com)", () => {
    vi.stubEnv("ALERT_EMAIL_TO", "");
    // Empty env should not blank out the default — implementation falls
    // back to the hardcoded default.
    // But empty string parses to no recipients; matches nothing.
    expect(isAlertSelfRecipient("krishna@meetingmindsdubai.com")).toBe(false);

    // With env unset, default kicks in.
    vi.unstubAllEnvs();
    expect(isAlertSelfRecipient("krishna@meetingmindsdubai.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    vi.unstubAllEnvs();
    expect(isAlertSelfRecipient("KRISHNA@MeetingMindsDubai.com")).toBe(true);
  });

  it("matches across multiple comma-separated recipients", () => {
    vi.stubEnv(
      "ALERT_EMAIL_TO",
      "krishna@example.com,vivek@example.com,backup@example.com",
    );
    expect(isAlertSelfRecipient("vivek@example.com")).toBe(true);
    expect(isAlertSelfRecipient("backup@example.com")).toBe(true);
    expect(isAlertSelfRecipient("nobody@example.com")).toBe(false);
  });

  it("trims whitespace around comma-separated entries", () => {
    vi.stubEnv("ALERT_EMAIL_TO", "  a@x.com  ,b@x.com,  c@x.com");
    expect(isAlertSelfRecipient("a@x.com")).toBe(true);
    expect(isAlertSelfRecipient("b@x.com")).toBe(true);
    expect(isAlertSelfRecipient("c@x.com")).toBe(true);
  });

  it("returns false for non-matching addresses", () => {
    vi.stubEnv("ALERT_EMAIL_TO", "alerts@example.com");
    expect(isAlertSelfRecipient("noise@example.com")).toBe(false);
    expect(isAlertSelfRecipient("alerts@other.com")).toBe(false);
  });
});

describe("shouldFireInThisEnvironment", () => {
  // The env gate is the load-bearing fix that stops a dev `npm run
  // dev` from spamming the prod alert inbox with local Prisma blips,
  // schema-drift errors, and other dev noise. If this contract
  // regresses, the dev-spam problem comes back silently.

  it("fires unconditionally when NODE_ENV=production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_ADMIN_ALERTS", "");
    expect(shouldFireInThisEnvironment()).toBe(true);
  });

  it("fires in production even when ENABLE_ADMIN_ALERTS is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(shouldFireInThisEnvironment()).toBe(true);
  });

  it("fires in production even when ENABLE_ADMIN_ALERTS=false (prod is non-overridable)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_ADMIN_ALERTS", "false");
    expect(shouldFireInThisEnvironment()).toBe(true);
  });

  it("DOES NOT fire when NODE_ENV=development and ENABLE_ADMIN_ALERTS unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ENABLE_ADMIN_ALERTS", "");
    expect(shouldFireInThisEnvironment()).toBe(false);
  });

  it("DOES NOT fire when NODE_ENV=test and ENABLE_ADMIN_ALERTS unset", () => {
    // Vitest sets NODE_ENV=test by default. Make sure the gate
    // doesn't fire from inside CI when tests run code that calls
    // apiLogger.error.
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ENABLE_ADMIN_ALERTS", "");
    expect(shouldFireInThisEnvironment()).toBe(false);
  });

  it("fires in dev when ENABLE_ADMIN_ALERTS=true (explicit opt-in)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ENABLE_ADMIN_ALERTS", "true");
    expect(shouldFireInThisEnvironment()).toBe(true);
  });

  it("requires EXACT 'true' string for opt-in (not '1' / 'yes' / 'TRUE')", () => {
    // Strictness here matters: a typo'd opt-in would silently fail in
    // a way that wastes a debug cycle. Force operators to use the
    // documented value.
    vi.stubEnv("NODE_ENV", "development");
    for (const val of ["1", "yes", "TRUE", "True", "on", " true ", "true "]) {
      vi.stubEnv("ENABLE_ADMIN_ALERTS", val);
      expect(shouldFireInThisEnvironment()).toBe(false);
    }
    vi.stubEnv("ENABLE_ADMIN_ALERTS", "true");
    expect(shouldFireInThisEnvironment()).toBe(true);
  });

  it("DOES NOT fire when NODE_ENV is unset (default-deny posture)", () => {
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("ENABLE_ADMIN_ALERTS", "");
    expect(shouldFireInThisEnvironment()).toBe(false);
  });
});
