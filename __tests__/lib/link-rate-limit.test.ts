/**
 * checkLinkRateLimit (Nov 9, 2026): the completion form and the survey limit
 * per personal link, with a crowd-sized ceiling per IP. Run against the real
 * in-memory limiter, as the venue scenarios that motivated it:
 *
 * 1. The desk tablet (one IP) completes far more than 5 registrations in 15
 *    minutes; the old per-IP limit refused the sixth attendee.
 * 2. One link replayed is still held to the strict number, and the refusal
 *    says it was the link.
 * 3. One address is still capped, at the crowd ceiling, and says it was the IP.
 * 4. Bodies without a token share one link bucket, so garbage stays bounded.
 */

import { describe, it, expect, vi } from "vitest";

vi.stubEnv("NEXTAUTH_SECRET", "test-secret");

import { checkLinkRateLimit, hashVerificationToken, VENUE_CROWD_IP_LIMITS } from "@/lib/security";

const STRICT = { limit: 5, windowMs: 15 * 60 * 1000 };
let n = 0;
const bucket = () => `test-link-${++n}-${Date.now()}`;

describe("checkLinkRateLimit", () => {
  it("lets one venue address complete many different registrations (the desk tablet)", () => {
    const b = bucket();
    for (let i = 0; i < 50; i++) {
      const r = checkLinkRateLimit({
        bucket: b, ip: "10.0.0.1", tokenHash: hashVerificationToken(`token-${i}`),
        perLink: STRICT, perIp: VENUE_CROWD_IP_LIMITS.write,
      });
      expect(r.allowed).toBe(true);
    }
  });

  it("holds one link to the strict number and names the link as the reason", () => {
    const b = bucket();
    const call = (ip: string) => checkLinkRateLimit({
      bucket: b, ip, tokenHash: hashVerificationToken("same-link"), perLink: STRICT, perIp: VENUE_CROWD_IP_LIMITS.write,
    });
    for (let i = 0; i < 5; i++) expect(call(`10.0.0.${i}`).allowed).toBe(true);
    // A different address does not reset it: the link is the person.
    const sixth = call("10.9.9.9");
    expect(sixth).toMatchObject({ allowed: false, refusedBy: "link" });
    expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("still caps one address, at the crowd ceiling, and names the IP as the reason", () => {
    const b = bucket();
    const perIp = { limit: 3, windowMs: 60_000 };
    for (let i = 0; i < 3; i++) {
      expect(checkLinkRateLimit({ bucket: b, ip: "10.0.0.2", tokenHash: `h${i}`, perLink: STRICT, perIp }).allowed).toBe(true);
    }
    expect(checkLinkRateLimit({ bucket: b, ip: "10.0.0.2", tokenHash: "h-new", perLink: STRICT, perIp }))
      .toMatchObject({ allowed: false, refusedBy: "ip" });
  });

  it("puts every tokenless body in one bucket, so garbage cannot fan out", () => {
    const b = bucket();
    const empty = hashVerificationToken("");
    for (let i = 0; i < 5; i++) {
      expect(checkLinkRateLimit({ bucket: b, ip: `10.1.0.${i}`, tokenHash: empty, perLink: STRICT, perIp: VENUE_CROWD_IP_LIMITS.write }).allowed).toBe(true);
    }
    expect(checkLinkRateLimit({ bucket: b, ip: "10.1.0.99", tokenHash: empty, perLink: STRICT, perIp: VENUE_CROWD_IP_LIMITS.write }))
      .toMatchObject({ allowed: false, refusedBy: "link" });
  });

  it("the crowd ceilings stay crowd-sized (a room of hundreds in 15 minutes)", () => {
    expect(VENUE_CROWD_IP_LIMITS.write.limit).toBeGreaterThanOrEqual(500);
    expect(VENUE_CROWD_IP_LIMITS.read.limit).toBeGreaterThanOrEqual(VENUE_CROWD_IP_LIMITS.write.limit);
  });
});

describe("the store under a spray of unique keys (Nov 9, 2026 review)", () => {
  const store = () => (globalThis as unknown as Record<string, Map<string, unknown>>).__ea_sys_rate_limit_store;

  it("past the hard cap the oldest entries go, at most once a second, and new ones are still counted", async () => {
    const { checkRateLimit } = await import("@/lib/security");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
      store().clear();
      // Earlier tests stamped the last cleanup with the REAL clock; once that is
      // past the faked 10:00 (any run after 10:00 UTC on Nov 9) no cleanup
      // would ever be due and this failed by wall-clock time.
      (globalThis as unknown as Record<string, number>).__ea_sys_rate_limit_last_cleanup = 0;
      for (let i = 0; i < 60_000; i++) checkRateLimit({ key: `spray:${i}`, limit: 5, windowMs: 900_000 });
      // Live entries above the cap: the cleanup at most once a second keeps it
      // from walking the Map on every request, so the store may stay large
      // within the same second.
      expect(store().size).toBe(60_000); // no per-request walk-and-evict within the second

      vi.setSystemTime(new Date("2026-11-09T10:00:02Z"));
      checkRateLimit({ key: "spray:new", limit: 5, windowMs: 900_000 });
      expect(store().size).toBeLessThanOrEqual(50_001);
      expect(store().has("spray:0")).toBe(false); // oldest evicted
      expect(store().has("spray:59999")).toBe(true); // newest kept
      expect(store().has("spray:new")).toBe(true);
    } finally {
      vi.useRealTimers();
      store().clear();
    }
  });
});
