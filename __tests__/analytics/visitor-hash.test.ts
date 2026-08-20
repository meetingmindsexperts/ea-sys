/**
 * Anonymous visitor identity.
 *
 * The rotation test is the one that matters. If the salt stops rotating we have
 * built a persistent cross-day identifier, the data becomes personal data, and
 * the "no tracking" claim in docs/SECURITY_AND_PRIVACY_POSTURE.md stops being
 * true. Everything else here is supporting work.
 */
import { describe, it, expect } from "vitest";
import {
  saltWindowFor,
  deriveDailySalt,
  computeVisitorHash,
  computeSessionHash,
  identifyVisitor,
  DEFAULT_SESSION_WINDOW_MS,
} from "@/analytics/core/visitor-hash";

const SECRET = "analytics-secret-for-tests";
const IP = "203.0.113.7";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0";
const SITE = "hematology-summit-2026";

function hashOn(iso: string, over: Partial<{ ip: string; userAgent: string; siteId: string }> = {}) {
  const now = new Date(iso);
  return computeVisitorHash({
    salt: deriveDailySalt(SECRET, saltWindowFor(now)),
    ip: over.ip ?? IP,
    userAgent: over.userAgent ?? UA,
    siteId: over.siteId ?? SITE,
  });
}

describe("salt rotation", () => {
  it("gives the same visitor the same identity within one day", () => {
    expect(hashOn("2026-08-20T01:00:00Z")).toBe(hashOn("2026-08-20T23:59:59Z"));
  });

  it("gives the same visitor a DIFFERENT identity the next day", () => {
    // This is the entire privacy argument. Freeze the salt and this fails.
    expect(hashOn("2026-08-20T23:59:59Z")).not.toBe(hashOn("2026-08-21T00:00:00Z"));
  });

  it("derives the window in UTC, not local time", () => {
    expect(saltWindowFor(new Date("2026-08-20T23:30:00Z"))).toBe("2026-08-20");
    expect(saltWindowFor(new Date("2026-08-21T00:30:00Z"))).toBe("2026-08-21");
  });

  it("refuses an empty secret rather than hashing with a known salt", () => {
    // Falling back to a default or an empty salt would make every hash
    // reproducible by anyone who read the source.
    expect(() => deriveDailySalt("", "2026-08-20")).toThrow(/secret is empty/i);
  });

  it("produces a different salt for a different secret", () => {
    expect(deriveDailySalt("a", "2026-08-20")).not.toBe(deriveDailySalt("b", "2026-08-20"));
  });
});

describe("visitor hash", () => {
  it("separates the same person across two tenants", () => {
    // Without siteId in the hash, two tenants could correlate a visitor between
    // them, which is the cross-site tracking this design exists to prevent.
    expect(hashOn("2026-08-20T10:00:00Z")).not.toBe(
      hashOn("2026-08-20T10:00:00Z", { siteId: "other-tenant-event" }),
    );
  });

  it("separates different people", () => {
    expect(hashOn("2026-08-20T10:00:00Z")).not.toBe(
      hashOn("2026-08-20T10:00:00Z", { ip: "203.0.113.8" }),
    );
    expect(hashOn("2026-08-20T10:00:00Z")).not.toBe(
      hashOn("2026-08-20T10:00:00Z", { userAgent: "Mozilla/5.0 Firefox/120" }),
    );
  });

  it("does not merge two people whose fields concatenate identically", () => {
    // Without a separator, ip "1.2.3" + ua "4x" and ip "1.2" + ua "34x" produce
    // the same input string and therefore the same person.
    const a = hashOn("2026-08-20T10:00:00Z", { ip: "1.2.3", userAgent: "4x" });
    const b = hashOn("2026-08-20T10:00:00Z", { ip: "1.2", userAgent: "34x" });
    expect(a).not.toBe(b);
  });

  it("leaks neither the inputs nor the salt into the output", () => {
    const salt = deriveDailySalt(SECRET, "2026-08-20");
    const h = computeVisitorHash({ salt, ip: IP, userAgent: UA, siteId: SITE });
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).not.toContain(IP);
    expect(h).not.toContain(SITE);
    expect(h).not.toContain(salt);
  });
});

describe("session hash", () => {
  const V = "a".repeat(64);

  it("is stable inside one window", () => {
    expect(computeSessionHash(V, new Date("2026-08-20T10:00:00Z"))).toBe(
      computeSessionHash(V, new Date("2026-08-20T10:29:00Z")),
    );
  });

  it("changes across a window boundary", () => {
    // The known, accepted artifact: a visit straddling the edge splits in two.
    // Documented rather than fixed, because fixing it means client-side storage.
    const a = computeSessionHash(V, new Date("2026-08-20T10:00:00Z"), 30 * 60_000);
    const b = computeSessionHash(V, new Date("2026-08-20T10:31:00Z"), 30 * 60_000);
    expect(a).not.toBe(b);
  });

  it("is different for different visitors in the same window", () => {
    const at = new Date("2026-08-20T10:00:00Z");
    expect(computeSessionHash("a".repeat(64), at)).not.toBe(computeSessionHash("b".repeat(64), at));
  });

  it("refuses a non-positive window instead of dividing by zero", () => {
    expect(() => computeSessionHash(V, new Date(), 0)).toThrow(/positive/i);
    expect(() => computeSessionHash(V, new Date(), -1)).toThrow(/positive/i);
  });

  it("defaults to 30 minutes", () => {
    expect(DEFAULT_SESSION_WINDOW_MS).toBe(30 * 60 * 1000);
  });
});

describe("identifyVisitor", () => {
  it("pairs the visitor and session hashes with the same day's salt", () => {
    const now = new Date("2026-08-20T10:00:00Z");
    const got = identifyVisitor({ secret: SECRET, ip: IP, userAgent: UA, siteId: SITE, now });

    expect(got.saltWindow).toBe("2026-08-20");
    expect(got.visitorHash).toBe(hashOn("2026-08-20T10:00:00Z"));
    expect(got.sessionHash).toBe(computeSessionHash(got.visitorHash, now));
  });

  it("rotates as a unit across the day boundary", () => {
    const before = identifyVisitor({
      secret: SECRET, ip: IP, userAgent: UA, siteId: SITE,
      now: new Date("2026-08-20T23:59:00Z"),
    });
    const after = identifyVisitor({
      secret: SECRET, ip: IP, userAgent: UA, siteId: SITE,
      now: new Date("2026-08-21T00:01:00Z"),
    });
    expect(after.visitorHash).not.toBe(before.visitorHash);
    expect(after.sessionHash).not.toBe(before.sessionHash);
  });
});
