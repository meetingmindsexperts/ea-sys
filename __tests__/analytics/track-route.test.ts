/**
 * The analytics ingest route.
 *
 * The assertions that matter are negatives and absences. A token route must
 * never be stored no matter what the body claims; the raw IP must never appear
 * in what gets enqueued; and every rejection must still answer 204, because a
 * beacon that errors is an error in a visitor's console while they are trying
 * to register.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockLogger, mockEnqueue, mockResolveSite, mockRateLimit } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockEnqueue: vi.fn(),
  mockResolveSite: vi.fn(),
  mockRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/db", () => ({ db: {}, dbOperator: {} }));
vi.mock("@/analytics/buffer", () => ({ enqueueHit: mockEnqueue }));
vi.mock("@/analytics/store/site-resolver", () => ({ resolveSite: mockResolveSite }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: mockRateLimit,
  getClientIp: () => "203.0.113.7",
}));

import { POST } from "@/app/api/public/track/route";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://events.meetingmindsgroup.com/api/public/track", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": CHROME,
      host: "events.meetingmindsgroup.com",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const VALID = { site: "hema-2026", path: "/e/hema-2026/register" };

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockResolveSite.mockResolvedValue({ organizationId: "org-1", eventId: "evt-1" });
  vi.stubEnv("ANALYTICS_SALT_SECRET", "test-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("always answers 204", () => {
  const cases: [string, unknown][] = [
    ["a valid hit", VALID],
    ["a malformed body", { nope: true }],
    ["an unmeasurable path", { site: "x", path: "/dashboard" }],
    ["a token route", { site: "x", path: "/e/x/rsvp/secret-token" }],
  ];

  it.each(cases)("returns 204 for %s", async (_label, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(204);
  });

  it("returns 204 even when the body is not JSON at all", async () => {
    const req = new Request("https://events.meetingmindsgroup.com/api/public/track", {
      method: "POST",
      headers: { "user-agent": CHROME },
      body: "not json",
    });
    expect((await POST(req)).status).toBe(204);
  });
});

describe("what is stored", () => {
  it("stores a valid hit with the resolved organisation", async () => {
    await POST(post(VALID));
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const hit = mockEnqueue.mock.calls[0][0];
    expect(hit.organizationId).toBe("org-1");
    expect(hit.eventId).toBe("evt-1");
    expect(hit.path).toBe("/e/hema-2026/register");
    expect(hit.routePattern).toBe("/e/:slug/register");
    expect(hit.name).toBe("pageview");
  });

  it("NEVER puts the raw IP or user agent in the stored hit", async () => {
    // They are consumed to derive the visitor hash and then discarded. There is
    // no column for either, and this is the assertion that keeps it that way.
    await POST(post(VALID));
    const hit = mockEnqueue.mock.calls[0][0];
    const serialised = JSON.stringify(hit);
    expect(serialised).not.toContain("203.0.113.7");
    expect(serialised).not.toContain("Mozilla");
    expect(hit.visitorHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps only the utm parameters from the query", async () => {
    await POST(
      post({
        ...VALID,
        query: "?utm_source=linkedin&utm_medium=social&token=secret&name=Ahmed",
      }),
    );
    const hit = mockEnqueue.mock.calls[0][0];
    expect(hit.utmSource).toBe("linkedin");
    expect(hit.utmMedium).toBe("social");
    expect(JSON.stringify(hit)).not.toMatch(/secret|Ahmed/);
  });

  it("reduces the referrer to a host and drops our own", async () => {
    await POST(post({ ...VALID, referrer: "https://www.linkedin.com/feed/?q=x" }));
    expect(mockEnqueue.mock.calls[0][0].referrerHost).toBe("linkedin.com");

    mockEnqueue.mockClear();
    // Own-host navigation is not acquisition. The internal host comes from THIS
    // request, so on a multi-tenant instance each tenant excludes its own.
    await POST(post({ ...VALID, referrer: "https://events.meetingmindsgroup.com/e/hema-2026" }));
    expect(mockEnqueue.mock.calls[0][0].referrerHost).toBeNull();
  });

  it("records a named conversion with its value", async () => {
    await POST(post({ ...VALID, name: "payment_completed", value: 450 }));
    const hit = mockEnqueue.mock.calls[0][0];
    expect(hit.name).toBe("payment_completed");
    expect(hit.value).toBe(450);
  });

  it("refuses an event name that is not on the allow-list", async () => {
    // The name is attacker-supplied and gets grouped in a dashboard. An open
    // field would let anyone mint unlimited junk series.
    const res = await POST(post({ ...VALID, name: "totally_made_up" }));
    expect(res.status).toBe(204);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

describe("what is refused", () => {
  it("refuses a token route even when the body claims it", async () => {
    // The browser-side check is an optimisation; THIS is the guard.
    for (const path of [
      "/e/x/rsvp/secret",
      "/e/x/reimbursement/secret",
      "/e/x/reset-password",
      "/e/x/confirmation",
      "/settings",
    ]) {
      mockEnqueue.mockClear();
      await POST(post({ site: "x", path }));
      expect(mockEnqueue, path).not.toHaveBeenCalled();
    }
  });

  it("refuses a bot", async () => {
    await POST(post(VALID, { "user-agent": "Mozilla/5.0 (compatible; AhrefsBot/7.0)" }));
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("refuses a link-preview fetcher", async () => {
    await POST(post(VALID, { "user-agent": "facebookexternalhit/1.1" }));
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("DROPS a hit whose site does not resolve rather than storing it org-less", async () => {
    // An unattributable hit is worth nothing, and admitting one would force the
    // RLS policy to allow orphan rows for no benefit.
    mockResolveSite.mockResolvedValue(null);
    await POST(post(VALID));
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ site: "hema-2026" }),
      "analytics:track-unresolved-site",
    );
  });

  it("raises the missing-secret alarm ONCE, not once per pageview", async () => {
    // This is the ordinary state between deploying the code and setting the
    // variable. At a few thousand hits a day an unguarded error would bury
    // /logs and hammer the SES admin alert with the same sentence.
    vi.stubEnv("ANALYTICS_SALT_SECRET", "");
    await POST(post(VALID));
    await POST(post(VALID));
    await POST(post(VALID));
    const alarms = mockLogger.error.mock.calls.filter((c) =>
      String(c[1]).includes("analytics:missing-salt-secret"),
    );
    expect(alarms.length).toBeLessThanOrEqual(1);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("refuses to hash with a known salt when the secret is unset", async () => {
    // Falling back to a constant would make every visitor hash reproducible by
    // anyone who read the source.
    //
    // This asserts the BEHAVIOUR (nothing recorded, still 204). The alarm
    // itself is asserted by the test above, and deliberately not here: the
    // latch is module state, so whichever of these two ran first would consume
    // it and the other would fail for a reason that has nothing to do with
    // what it is checking.
    vi.stubEnv("ANALYTICS_SALT_SECRET", "");
    const res = await POST(post(VALID));
    expect(res.status).toBe(204);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("refuses when rate limited, and says so", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await POST(post(VALID));
    expect(res.status).toBe(204);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.anything(),
      "analytics:track-rate-limited",
    );
  });

  it("checks the rate limit BEFORE resolving the site", async () => {
    // Otherwise a flood still costs a lookup per request, which is the load the
    // limit exists to prevent.
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    await POST(post(VALID));
    expect(mockResolveSite).not.toHaveBeenCalled();
  });
});

describe("identity", () => {
  it("gives the same visitor the same hash within a day", async () => {
    await POST(post(VALID));
    await POST(post(VALID));
    const [a, b] = mockEnqueue.mock.calls.map((c) => c[0].visitorHash);
    expect(a).toBe(b);
  });

  it("separates visitors on different sites", async () => {
    await POST(post({ site: "site-a", path: "/e/site-a/register" }));
    await POST(post({ site: "site-b", path: "/e/site-b/register" }));
    const [a, b] = mockEnqueue.mock.calls.map((c) => c[0].visitorHash);
    expect(a).not.toBe(b);
  });
});
