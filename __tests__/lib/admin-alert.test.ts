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
  isLocalInstance,
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
  // The app's own address, as production has it. Left to the machine it is
  // whatever .env holds (localhost on a laptop, nothing in CI), and since
  // Nov 18, 2026 a local address switches alerts off: the tests below would
  // pass or fail by where they ran.
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://events.meetingmindsgroup.com");
  vi.stubEnv("NEXTAUTH_URL", "https://events.meetingmindsgroup.com");
  vi.stubEnv("GIT_SHA", "");
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


describe("a local instance never emails alerts (owner, Nov 18, 2026)", () => {
  // The test server, the gate's server and a local `npm start` all run with
  // NODE_ENV=production. Until this rule they emailed the production alert
  // inbox about errors the tests provoke on purpose.

  const local = (address: string) => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", address);
    vi.stubEnv("NEXTAUTH_URL", address);
  };

  it.each([
    "http://localhost:3199",
    "http://LOCALHOST:3113",
    "http://acme.localhost:3114",
    "http://127.0.0.1:3123",
    "http://[::1]:3000",
  ])("%s is local", (address) => {
    local(address);
    expect(isLocalInstance()).toBe(true);
  });

  it.each([
    "https://events.meetingmindsgroup.com",
    "https://localhost.example.com",
    "https://notlocalhost",
    "http://10.0.0.5:3000",
    "not a url",
  ])("%s is not local", (address) => {
    local(address);
    expect(isLocalInstance()).toBe(false);
  });

  it("no address at all is not local: nothing configured never switches alerts off", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NEXTAUTH_URL", "");
    expect(isLocalInstance()).toBe(false);
  });

  it("the public address is read first, as the alert email's own links read it", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://events.meetingmindsgroup.com");
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    expect(isLocalInstance()).toBe(false);
  });

  it("a DEPLOYED image is never local, whatever its address says", () => {
    // The safety: an image CI built carries its commit. If its address were
    // ever set to localhost by mistake, production must go on alerting.
    local("http://localhost:3000");
    vi.stubEnv("GIT_SHA", "701a70e6a70376292dcad6e3bc498a721c9bb20a");
    expect(isLocalInstance()).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(shouldFireInThisEnvironment()).toBe(true);
  });

  it("a build with no commit baked in (\"unknown\") on localhost is local", () => {
    local("http://localhost:3199");
    vi.stubEnv("GIT_SHA", "unknown");
    expect(isLocalInstance()).toBe(true);
  });

  it("does not fire from a local instance, even with NODE_ENV=production", () => {
    local("http://localhost:3199");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_ADMIN_ALERTS", "");
    expect(shouldFireInThisEnvironment()).toBe(false);
  });

  it("fires from a local instance when the engineer opts in", () => {
    local("http://localhost:3199");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_ADMIN_ALERTS", "true");
    expect(shouldFireInThisEnvironment()).toBe(true);
  });
});
