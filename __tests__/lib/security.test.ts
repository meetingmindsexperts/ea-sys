import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getClientIp, checkRateLimit, hashVerificationToken } from "@/lib/security";

// ── getClientIp ────────────────────────────────────────────────────────────

describe("getClientIp", () => {
  it("returns first IP from x-forwarded-for", () => {
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("returns first IP from comma-separated x-forwarded-for", () => {
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.10.11.12" },
    });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("trims whitespace from x-forwarded-for", () => {
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "  1.2.3.4  , 5.6.7.8" },
    });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when no x-forwarded-for", () => {
    const req = new Request("http://localhost", {
      headers: { "x-real-ip": "10.0.0.1" },
    });
    expect(getClientIp(req)).toBe("10.0.0.1");
  });

  it('returns "unknown" when no IP headers present', () => {
    const req = new Request("http://localhost");
    expect(getClientIp(req)).toBe("unknown");
  });
});

// ── checkRateLimit ─────────────────────────────────────────────────────────

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Clear rate limit store between tests
    const g = globalThis as Record<string, unknown>;
    delete g["__ea_sys_rate_limit_store"];
    delete g["__ea_sys_rate_limit_last_cleanup"];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows the first request", () => {
    const result = checkRateLimit({ key: "test-1", limit: 5, windowMs: 60000 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("decrements remaining with each request", () => {
    checkRateLimit({ key: "test-2", limit: 3, windowMs: 60000 });
    const second = checkRateLimit({ key: "test-2", limit: 3, windowMs: 60000 });
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(1);
  });

  it("blocks when limit is reached", () => {
    const opts = { key: "test-3", limit: 2, windowMs: 60000 };
    checkRateLimit(opts); // 1st
    checkRateLimit(opts); // 2nd (at limit)
    const third = checkRateLimit(opts); // 3rd (blocked)
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it("resets after window expires", () => {
    const opts = { key: "test-4", limit: 1, windowMs: 10000 };
    checkRateLimit(opts); // 1st — uses up limit
    const blocked = checkRateLimit(opts);
    expect(blocked.allowed).toBe(false);

    // Advance time past the window
    vi.advanceTimersByTime(11000);
    const afterReset = checkRateLimit(opts);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(0); // limit 1, count 1 → 0 remaining
  });

  it("tracks different keys independently", () => {
    const optsA = { key: "key-a", limit: 1, windowMs: 60000 };
    const optsB = { key: "key-b", limit: 1, windowMs: 60000 };

    checkRateLimit(optsA); // exhaust key-a
    const blockedA = checkRateLimit(optsA);
    expect(blockedA.allowed).toBe(false);

    const resultB = checkRateLimit(optsB); // key-b still fresh
    expect(resultB.allowed).toBe(true);
  });

  it("returns retryAfterSeconds", () => {
    const opts = { key: "test-retry", limit: 1, windowMs: 30000 };
    checkRateLimit(opts);

    vi.advanceTimersByTime(10000);
    const blocked = checkRateLimit(opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(20);
  });
});

// ── hashVerificationToken ──────────────────────────────────────────────────

describe("hashVerificationToken", () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = "test-secret-key";
  });

  it("returns a 64-char hex string (SHA-256)", () => {
    const hash = hashVerificationToken("my-token");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic (same input → same hash)", () => {
    const hash1 = hashVerificationToken("same-token");
    const hash2 = hashVerificationToken("same-token");
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different inputs", () => {
    const hash1 = hashVerificationToken("token-a");
    const hash2 = hashVerificationToken("token-b");
    expect(hash1).not.toBe(hash2);
  });
});
