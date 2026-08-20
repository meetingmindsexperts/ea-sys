/**
 * What may be measured, and what survives into storage.
 *
 * The tests that matter here assert NEGATIVES. A token route must never match,
 * and a stored path must never carry a query string. Those are the two ways
 * this feature could put a credential or a person's name into the database, and
 * a passing positive test says nothing about either.
 */
import { describe, it, expect } from "vitest";
import {
  matchRoute,
  isMeasurable,
  normalisePath,
  extractUtm,
  referrerHost,
  MEASURABLE_ROUTES,
} from "@/analytics/core/path-policy";

describe("allow-listed routes", () => {
  it("matches the public event pages and captures their parameters", () => {
    expect(matchRoute("/e/hema-2026")).toEqual({
      pattern: "/e/:slug",
      params: { slug: "hema-2026" },
    });
    expect(matchRoute("/e/hema-2026/register/early-bird")).toEqual({
      pattern: "/e/:slug/register/:category",
      params: { slug: "hema-2026", category: "early-bird" },
    });
    expect(matchRoute("/e/hema-2026/session/clx123")).toEqual({
      pattern: "/e/:slug/session/:sessionId",
      params: { slug: "hema-2026", sessionId: "clx123" },
    });
  });

  it("groups across events by pattern, so one page can be compared to itself", () => {
    expect(matchRoute("/e/a/agenda")?.pattern).toBe(matchRoute("/e/b/agenda")?.pattern);
  });
});

describe("token routes are unmeasurable by construction", () => {
  // These carry bearer credentials or a person's name in the URL. The allow-list
  // exists so that adding a public route later does NOT silently start measuring
  // it; an exclude-list would fail open here.
  const forbidden = [
    "/e/hema-2026/rsvp/abc123token",
    "/e/hema-2026/reimbursement/abc123token",
    "/e/hema-2026/speaker-form/abc123token",
    "/e/hema-2026/reset-password",
    "/e/hema-2026/complete-registration",
    "/e/hema-2026/presenter-agreement",
    "/e/hema-2026/speaker-agreement",
    "/e/hema-2026/survey",
    "/e/hema-2026/confirmation",
    "/e/hema-2026/my-registration",
    "/e/hema-2026/login",
    "/dashboard",
    "/settings",
    "/api/public/events/x/register",
  ];

  it.each(forbidden)("refuses %s", (path) => {
    expect(matchRoute(path)).toBeNull();
    expect(isMeasurable(path)).toBe(false);
  });

  it("has no token-shaped pattern in the allow-list at all", () => {
    // A source-level guard: if someone adds one, this fails before any runtime
    // behaviour has to be reasoned about.
    for (const pattern of MEASURABLE_ROUTES) {
      expect(pattern).not.toMatch(/token|password|confirmation|agreement|survey|reimbursement|rsvp/i);
    }
  });

  it("rejects a path that is not absolute, so a URL cannot pose as one", () => {
    expect(matchRoute("e/hema-2026")).toBeNull();
    expect(matchRoute("//evil.com/e/hema-2026")).toBeNull();
  });
});

describe("normalisePath", () => {
  it("NEVER returns a query string", () => {
    // The invariant that keeps ?name= and ?token= out of the database.
    const cases = [
      "/e/x/confirmation?id=abc&name=Ahmed",
      "/e/x/reset-password?token=secret&email=a@b.com",
      "/e/x/register?utm_source=linkedin",
      "https://events.meetingmindsgroup.com/e/x?token=leak#frag",
    ];
    for (const c of cases) {
      const out = normalisePath(c);
      expect(out).not.toContain("?");
      expect(out).not.toContain("#");
      expect(out).not.toMatch(/token|name=|email/i);
    }
  });

  it("accepts a full URL or a bare path", () => {
    expect(normalisePath("https://events.meetingmindsgroup.com/e/x/agenda")).toBe("/e/x/agenda");
    expect(normalisePath("/e/x/agenda")).toBe("/e/x/agenda");
  });

  it("treats a trailing slash as the same page", () => {
    expect(normalisePath("/e/x/agenda/")).toBe("/e/x/agenda");
    expect(normalisePath("/")).toBe("/");
  });

  it("returns null for junk rather than a path-shaped guess", () => {
    expect(normalisePath("")).toBeNull();
    expect(normalisePath("javascript:alert(1)")).toBeNull();
    expect(normalisePath("not-a-path")).toBeNull();
  });
});

describe("extractUtm", () => {
  it("keeps the three campaign parameters", () => {
    expect(extractUtm("?utm_source=linkedin&utm_medium=social&utm_campaign=spring")).toEqual({
      utmSource: "linkedin",
      utmMedium: "social",
      utmCampaign: "spring",
    });
  });

  it("drops everything else, including the dangerous ones", () => {
    const got = extractUtm("?token=secret&name=Ahmed&email=a@b.com&utm_source=linkedin");
    expect(got.utmSource).toBe("linkedin");
    expect(JSON.stringify(got)).not.toMatch(/secret|Ahmed|a@b\.com/);
    expect(Object.keys(got).sort()).toEqual(["utmCampaign", "utmMedium", "utmSource"]);
  });

  it("works with or without the leading question mark, and on nothing", () => {
    expect(extractUtm("utm_source=x").utmSource).toBe("x");
    expect(extractUtm("").utmSource).toBeNull();
    expect(extractUtm(null).utmSource).toBeNull();
  });

  it("bounds the stored value so a crafted campaign cannot be huge", () => {
    expect(extractUtm(`?utm_source=${"a".repeat(5000)}`).utmSource).toHaveLength(255);
  });
});

describe("referrerHost", () => {
  it("reduces a referrer to its host and nothing else", () => {
    // Never the full URL: a referring page's path and query are somebody else's
    // data and none of our business.
    expect(referrerHost("https://www.linkedin.com/feed/?q=secret")).toBe("linkedin.com");
    expect(referrerHost("http://t.co/abc")).toBe("t.co");
  });

  it("rejects a bare IPv4, which is never real acquisition", () => {
    // Our own box reached by address, a scanner, or something misconfigured.
    // Left in, it showed up as the second largest acquisition source on prod.
    expect(referrerHost("http://3.108.247.193/e/x")).toBeNull();
    expect(referrerHost("https://192.168.1.1/")).toBeNull();
  });

  it("treats configured internal hosts as navigation, not acquisition", () => {
    const internal = ["events.meetingmindsgroup.com"];
    expect(referrerHost("https://events.meetingmindsgroup.com/events", internal)).toBeNull();
    expect(referrerHost("https://sub.events.meetingmindsgroup.com/x", internal)).toBeNull();
  });

  it("anchors the internal match on a dot, so a look-alike is still external", () => {
    const internal = ["meetingmindsgroup.com"];
    expect(referrerHost("https://notmeetingmindsgroup.com/x", internal)).toBe(
      "notmeetingmindsgroup.com",
    );
    expect(referrerHost("https://meetingmindsgroup.com.evil.com/x", internal)).toBe(
      "meetingmindsgroup.com.evil.com",
    );
  });

  it("takes the internal list as a parameter rather than hardcoding a domain", () => {
    // On a multi-tenant instance each tenant has its own domain; a hardcoded one
    // would count every other tenant's internal navigation as acquisition.
    expect(referrerHost("https://tenant-a.com/x", ["tenant-a.com"])).toBeNull();
    expect(referrerHost("https://tenant-a.com/x", ["tenant-b.com"])).toBe("tenant-a.com");
  });

  it("rejects junk instead of inventing a host", () => {
    expect(referrerHost("")).toBeNull();
    expect(referrerHost("-")).toBeNull();
    expect(referrerHost("localhost")).toBeNull();
    expect(referrerHost("android-app://com.example")).toBeNull();
  });

  it("strips userinfo and port", () => {
    expect(referrerHost("https://user:pw@example.com:8443/x")).toBe("example.com");
  });
});
