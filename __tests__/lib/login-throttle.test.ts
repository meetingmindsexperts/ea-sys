/**
 * Failed-sign-in throttle.
 *
 * What these tests hold in place — each maps to a way the naive implementation
 * (just calling `checkRateLimit`) would have been wrong:
 *   - checking whether you're blocked must not itself cost you an attempt,
 *     otherwise merely loading the login page would consume budget
 *   - only FAILURES are charged, so a venue full of people signing in
 *     successfully from one NAT address never locks itself out
 *   - a success clears the email bucket, so two typos then a success leaves
 *     the user with a clean slate
 *   - a success does NOT clear the IP bucket, so an attacker holding one valid
 *     account can't reset the spray counter between batches of guesses
 *   - the email bucket is charged for unknown addresses too, so being told
 *     you're throttled reveals nothing about whether an account exists
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  isLoginBlocked,
  recordLoginFailure,
  clearLoginFailures,
  __resetLoginThrottleForTests,
  EMAIL_FAILURE_LIMIT,
  IP_FAILURE_LIMIT,
  FAILURE_WINDOW_MS,
} from "@/lib/login-throttle";

const EMAIL = "victim@example.com";
const IP = "203.0.113.7";

beforeEach(() => {
  __resetLoginThrottleForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isLoginBlocked — peeking costs nothing", () => {
  it("never blocks on a clean slate, no matter how often it's asked", () => {
    for (let i = 0; i < EMAIL_FAILURE_LIMIT * 3; i++) {
      expect(isLoginBlocked(EMAIL, IP).blocked).toBe(false);
    }
  });

  it("does not consume budget — the full failure allowance survives peeking", () => {
    for (let i = 0; i < 50; i++) isLoginBlocked(EMAIL, IP);

    // One short of the limit is still allowed.
    for (let i = 0; i < EMAIL_FAILURE_LIMIT - 1; i++) recordLoginFailure(EMAIL, IP);
    expect(isLoginBlocked(EMAIL, IP).blocked).toBe(false);
  });
});

describe("email bucket", () => {
  it("blocks at the limit and names the email as the reason", () => {
    for (let i = 0; i < EMAIL_FAILURE_LIMIT; i++) recordLoginFailure(EMAIL, IP);

    const result = isLoginBlocked(EMAIL, IP);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("email");
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("is case- and whitespace-insensitive, so casing can't buy a fresh bucket", () => {
    for (let i = 0; i < EMAIL_FAILURE_LIMIT; i++) recordLoginFailure(EMAIL, IP);
    expect(isLoginBlocked("  VICTIM@EXAMPLE.COM  ", IP).blocked).toBe(true);
  });

  it("isolates different addresses from each other", () => {
    for (let i = 0; i < EMAIL_FAILURE_LIMIT; i++) recordLoginFailure(EMAIL, IP);
    expect(isLoginBlocked("someone-else@example.com", "198.51.100.9").blocked).toBe(false);
  });

  it("charges unknown addresses too — no account-existence oracle", () => {
    const ghost = "no-such-person@example.com";
    for (let i = 0; i < EMAIL_FAILURE_LIMIT; i++) recordLoginFailure(ghost, IP);
    expect(isLoginBlocked(ghost, IP).blocked).toBe(true);
  });
});

describe("IP bucket", () => {
  it("is far looser than the email bucket, so a shared venue IP survives", () => {
    // Well past the per-email limit, spread across distinct addresses — the
    // conference-WiFi case that a naive per-IP limit would have locked out.
    for (let i = 0; i < EMAIL_FAILURE_LIMIT * 5; i++) {
      recordLoginFailure(`attendee${i}@example.com`, IP);
    }
    expect(isLoginBlocked("fresh-attendee@example.com", IP).blocked).toBe(false);
  });

  it("still stops a single host spraying past its own limit", () => {
    for (let i = 0; i < IP_FAILURE_LIMIT; i++) {
      recordLoginFailure(`spray${i}@example.com`, IP);
    }
    const result = isLoginBlocked("anything@example.com", IP);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("ip");
  });

  it("ignores an unknown IP rather than lumping every such attempt together", () => {
    for (let i = 0; i < IP_FAILURE_LIMIT * 2; i++) {
      recordLoginFailure(`x${i}@example.com`, "unknown");
    }
    expect(isLoginBlocked("someone@example.com", "unknown").blocked).toBe(false);
  });
});

describe("clearLoginFailures — success resets the person, not the address", () => {
  it("wipes the email bucket so typos-then-success leaves no trace", () => {
    for (let i = 0; i < EMAIL_FAILURE_LIMIT - 1; i++) recordLoginFailure(EMAIL, IP);
    clearLoginFailures(EMAIL);

    // Full allowance is back.
    for (let i = 0; i < EMAIL_FAILURE_LIMIT - 1; i++) recordLoginFailure(EMAIL, IP);
    expect(isLoginBlocked(EMAIL, IP).blocked).toBe(false);
  });

  it("leaves the IP bucket alone — one valid account can't reset a spray", () => {
    for (let i = 0; i < IP_FAILURE_LIMIT; i++) {
      recordLoginFailure(`spray${i}@example.com`, IP);
    }
    // The attacker signs into their own legitimate account from the same host.
    clearLoginFailures("attacker-own-account@example.com");

    expect(isLoginBlocked("next-target@example.com", IP).blocked).toBe(true);
  });
});

describe("window expiry", () => {
  it("lets a blocked address back in once the window passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T10:00:00Z"));

    for (let i = 0; i < EMAIL_FAILURE_LIMIT; i++) recordLoginFailure(EMAIL, IP);
    expect(isLoginBlocked(EMAIL, IP).blocked).toBe(true);

    vi.setSystemTime(new Date(Date.now() + FAILURE_WINDOW_MS + 1000));
    expect(isLoginBlocked(EMAIL, IP).blocked).toBe(false);
  });

  it("reports a wait that shrinks as the window drains", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T10:00:00Z"));

    for (let i = 0; i < EMAIL_FAILURE_LIMIT; i++) recordLoginFailure(EMAIL, IP);
    const first = isLoginBlocked(EMAIL, IP).retryAfterSeconds;

    vi.setSystemTime(new Date(Date.now() + 60_000));
    const later = isLoginBlocked(EMAIL, IP).retryAfterSeconds;

    expect(later).toBeLessThan(first);
    expect(later).toBeGreaterThan(0);
  });

  it("reports the LONGER wait when both buckets are tripped", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T10:00:00Z"));

    // Fill the IP bucket first, so its window started earlier and ends sooner.
    for (let i = 0; i < IP_FAILURE_LIMIT; i++) {
      recordLoginFailure(`spray${i}@example.com`, IP);
    }
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    for (let i = 0; i < EMAIL_FAILURE_LIMIT; i++) recordLoginFailure(EMAIL, IP);

    const result = isLoginBlocked(EMAIL, IP);
    expect(result.blocked).toBe(true);
    // Never tell someone to come back sooner than they actually can.
    expect(result.retryAfterSeconds).toBeGreaterThan(10 * 60 - 5);
  });
});
