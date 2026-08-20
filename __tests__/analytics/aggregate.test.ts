/**
 * Dashboard rollups.
 *
 * Two of these guard mistakes that would be invisible on the page because the
 * number would still look plausible: counting engagement hits as pageviews
 * (inflates every figure by roughly the share of visitors who stayed a second),
 * and summing daily uniques into a range total (double-counts anyone who came
 * back the next day). Both produce a bigger, nicer number that is wrong.
 */
import { describe, it, expect } from "vitest";
import { summariseTraffic, buildRegistrationFunnel } from "@/analytics/core/aggregate";
import type { AnalyticsHit } from "@/analytics/core/types";

const FROM = new Date("2026-08-18T00:00:00Z");
const TO = new Date("2026-08-20T23:59:59Z");

function hit(over: Partial<AnalyticsHit> = {}): AnalyticsHit {
  return {
    siteId: "s",
    name: "pageview",
    path: "/e/x/register",
    routePattern: "/e/:slug/register",
    visitorHash: "v1",
    sessionHash: "sess1",
    occurredAt: new Date("2026-08-20T10:00:00Z"),
    ...over,
  };
}

describe("counting", () => {
  it("counts pageviews and distinct visitors separately", () => {
    const s = summariseTraffic(
      [hit({ visitorHash: "a" }), hit({ visitorHash: "a" }), hit({ visitorHash: "b" })],
      { from: FROM, to: TO },
    );
    expect(s.pageviews).toBe(3);
    expect(s.visitors).toBe(2);
  });

  it("does NOT count engagement hits as pageviews", () => {
    // They are a second hit about the same view. Counting them would inflate
    // every pageview figure by the share of visitors who stayed a second.
    const s = summariseTraffic(
      [hit(), hit({ name: "page_engagement", durationMs: 30_000, scrollDepth: 60 })],
      { from: FROM, to: TO },
    );
    expect(s.pageviews).toBe(1);
    expect(s.avgDurationMs).toBe(30_000);
    expect(s.avgScrollDepth).toBe(60);
  });

  it("counts range visitors distinctly, not as the sum of the daily figures", () => {
    // The same person on two days is ONE visitor over the range. Summing the
    // daily counts is the easy mistake and produces a bigger, wronger number.
    const s = summariseTraffic(
      [
        hit({ visitorHash: "a", occurredAt: new Date("2026-08-19T10:00:00Z") }),
        hit({ visitorHash: "a", occurredAt: new Date("2026-08-20T10:00:00Z") }),
      ],
      { from: FROM, to: TO },
    );
    expect(s.visitors).toBe(1);
    expect(s.daily.reduce((n, d) => n + d.visitors, 0)).toBe(2);
  });

  it("reports null engagement rather than zero when nothing was reported", () => {
    // Zero would read as "nobody stayed", which is a claim. Null is the truth.
    const s = summariseTraffic([hit()], { from: FROM, to: TO });
    expect(s.avgDurationMs).toBeNull();
    expect(s.avgScrollDepth).toBeNull();
  });
});

describe("bounce rate", () => {
  it("is the share of sessions with exactly one pageview", () => {
    const s = summariseTraffic(
      [
        hit({ sessionHash: "one" }),
        hit({ sessionHash: "two" }),
        hit({ sessionHash: "two", path: "/e/x" }),
      ],
      { from: FROM, to: TO },
    );
    expect(s.sessions).toBe(2);
    expect(s.bounceRate).toBe(0.5);
  });

  it("is zero, not NaN, with no sessions at all", () => {
    const s = summariseTraffic([], { from: FROM, to: TO });
    expect(s.bounceRate).toBe(0);
    expect(Number.isFinite(s.bounceRate)).toBe(true);
  });
});

describe("time buckets", () => {
  it("includes quiet days as zeros rather than omitting them", () => {
    // A gap in the array becomes a gap in the chart, which reads as missing
    // data rather than as a day nobody visited.
    const s = summariseTraffic([hit({ occurredAt: new Date("2026-08-20T10:00:00Z") })], {
      from: FROM,
      to: TO,
      timeZone: "UTC",
    });
    expect(s.daily.map((d) => d.date)).toEqual(["2026-08-18", "2026-08-19", "2026-08-20"]);
    expect(s.daily[0].pageviews).toBe(0);
    expect(s.daily[2].pageviews).toBe(1);
  });

  it("buckets by the EVENT's day, not the viewer's", () => {
    // 22:00 UTC is already tomorrow in Dubai. An organiser's evening traffic
    // must not land on the wrong day because someone opened the page in London.
    const late = hit({ occurredAt: new Date("2026-08-19T22:00:00Z") });
    const utc = summariseTraffic([late], { from: FROM, to: TO, timeZone: "UTC" });
    const dubai = summariseTraffic([late], { from: FROM, to: TO, timeZone: "Asia/Dubai" });
    expect(utc.daily.find((d) => d.date === "2026-08-19")?.pageviews).toBe(1);
    expect(dubai.daily.find((d) => d.date === "2026-08-20")?.pageviews).toBe(1);
  });
});

describe("breakdowns", () => {
  it("ranks pages by pattern and shows a real path as the example", () => {
    const s = summariseTraffic(
      [
        hit({ path: "/e/a/register", routePattern: "/e/:slug/register", visitorHash: "v1" }),
        hit({ path: "/e/a/register", routePattern: "/e/:slug/register", visitorHash: "v2" }),
        hit({ path: "/e/b", routePattern: "/e/:slug", visitorHash: "v3" }),
      ],
      { from: FROM, to: TO },
    );
    expect(s.topPages[0]).toMatchObject({
      routePattern: "/e/:slug/register",
      examplePath: "/e/a/register",
      pageviews: 2,
      visitors: 2,
    });
  });

  it("counts referrers and devices by visitor, not by hit", () => {
    // One person refreshing five times is one person who came from LinkedIn.
    const s = summariseTraffic(
      [
        hit({ referrerHost: "linkedin.com", deviceType: "mobile", visitorHash: "v1" }),
        hit({ referrerHost: "linkedin.com", deviceType: "mobile", visitorHash: "v1" }),
        hit({ referrerHost: "google.com", deviceType: "desktop", visitorHash: "v2" }),
      ],
      { from: FROM, to: TO },
    );
    // Equal counts tie-break alphabetically, deliberately: a non-deterministic
    // order would reshuffle the list between page loads for no reason.
    expect(s.topReferrers).toEqual([
      { label: "google.com", visitors: 1 },
      { label: "linkedin.com", visitors: 1 },
    ]);
    expect(s.devices.find((d) => d.label === "mobile")?.visitors).toBe(1);
  });

  it("handles no hits at all without throwing", () => {
    const s = summariseTraffic([], { from: FROM, to: TO });
    expect(s).toMatchObject({ pageviews: 0, visitors: 0, sessions: 0 });
    expect(s.topPages).toEqual([]);
  });
});

describe("registration funnel", () => {
  const hits = [
    hit({ visitorHash: "v1", routePattern: "/e/:slug", path: "/e/x" }),
    hit({ visitorHash: "v2", routePattern: "/e/:slug", path: "/e/x" }),
    hit({ visitorHash: "v3", routePattern: "/e/:slug", path: "/e/x" }),
    hit({ visitorHash: "v1", routePattern: "/e/:slug/register" }),
    hit({ visitorHash: "v1", routePattern: "/e/:slug/register" }), // a refresh
    hit({ visitorHash: "v2", routePattern: "/e/:slug/register" }),
  ];

  it("counts steps in visitors, not pageviews", () => {
    // v1 refreshed the register page. That is one person considering it, not
    // two, and counting hits would flatter the rate.
    const f = buildRegistrationFunnel(hits, 1);
    expect(f.map((s) => s.count)).toEqual([3, 2, 1]);
  });

  it("takes the final step from the Registration table, not from a hit", () => {
    // A conversion beacon can be lost to a closed tab. The registration count
    // is independently knowable, so under-reporting it would be a bad trade.
    const f = buildRegistrationFunnel(hits, 42);
    expect(f[2].count).toBe(42);
  });

  it("reports drop-off between the steps", () => {
    const f = buildRegistrationFunnel(hits, 1);
    expect(f[1].dropOff).toBe(1);
    expect(f[2].dropOff).toBe(1);
    expect(f[2].conversionRate).toBeCloseTo(1 / 3);
  });

  it("survives an event with no traffic recorded yet", () => {
    // The ordinary state for weeks after deploy. Must be zeros, not NaN.
    const f = buildRegistrationFunnel([], 0);
    expect(f.every((s) => Number.isFinite(s.conversionRate))).toBe(true);
    expect(f.map((s) => s.count)).toEqual([0, 0, 0]);
  });
});
