/**
 * IP → location resolution.
 *
 * What these tests hold in place:
 *   - the SSRF guard: an address is validated BEFORE it is interpolated into
 *     an outbound URL, so a hostile header value can never redirect the call
 *   - private / unroutable addresses resolve permanently to "no location"
 *     rather than queuing a doomed lookup on every view (in development every
 *     single row would otherwise retry forever)
 *   - the ok:false ⇄ ok:true distinction, which is what tells the caller
 *     whether to stamp `geoResolvedAt` (never retry) or leave it (retry later)
 *   - it NEVER throws, so a provider outage can only ever mean "the location
 *     column stays empty"
 *   - the provider's 200-with-an-error-flag responses are treated as failures,
 *     not stored as real data
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  isValidIpAddress,
  isPrivateOrUnroutableIp,
  isGeoEnabled,
  resolveIpLocation,
  __resetGeoCacheForTests,
} from "@/lib/login-geo";

const PUBLIC_IP = "203.0.113.7";

beforeEach(() => {
  __resetGeoCacheForTests();
  delete process.env.LOGIN_GEO_ENABLED;
  delete process.env.LOGIN_GEO_TOKEN;
  vi.restoreAllMocks();
});

afterEach(() => {
  delete process.env.LOGIN_GEO_ENABLED;
  delete process.env.LOGIN_GEO_TOKEN;
});

describe("isValidIpAddress — the SSRF guard", () => {
  it.each(["1.2.3.4", "203.0.113.7", "255.255.255.255", "0.0.0.0"])(
    "accepts the IPv4 address %s",
    (ip) => expect(isValidIpAddress(ip)).toBe(true),
  );

  it.each(["::1", "2001:db8::1", "fe80::1", "2001:0db8:0000:0000:0000:ff00:0042:8329"])(
    "accepts the IPv6 address %s",
    (ip) => expect(isValidIpAddress(ip)).toBe(true),
  );

  it.each([
    ["a hostname", "evil.example.com"],
    ["a full URL", "http://evil.example.com/"],
    ["an out-of-range octet", "999.1.1.1"],
    ["a leading-zero octet", "01.2.3.4"],
    ["a path traversal attempt", "1.2.3.4/../admin"],
    ["a query-string injection", "1.2.3.4?x=1"],
    ["an at-sign host swap", "1.2.3.4@evil.com"],
    ["two :: groups", "2001::db8::1"],
    ["an empty string", ""],
    ["the unknown sentinel", "unknown"],
  ])("rejects %s", (_label, ip) => {
    expect(isValidIpAddress(ip)).toBe(false);
  });

  it("rejects an absurdly long value rather than trying to parse it", () => {
    expect(isValidIpAddress("1".repeat(200))).toBe(false);
  });
});

describe("isPrivateOrUnroutableIp", () => {
  it.each([
    "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.255",
    "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "unknown", "",
  ])("treats %s as having no public location", (ip) => {
    expect(isPrivateOrUnroutableIp(ip)).toBe(true);
  });

  it.each(["203.0.113.7", "8.8.8.8", "172.32.0.1", "192.169.1.1", "100.128.0.1"])(
    "treats %s as routable",
    (ip) => expect(isPrivateOrUnroutableIp(ip)).toBe(false),
  );
});

describe("isGeoEnabled", () => {
  it("is on by default so the feature works on a fresh deploy", () => {
    expect(isGeoEnabled()).toBe(true);
  });

  it("is switched off by the single documented env var", () => {
    process.env.LOGIN_GEO_ENABLED = "false";
    expect(isGeoEnabled()).toBe(false);
  });
});

describe("resolveIpLocation", () => {
  it("resolves a public address and returns city + country", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ city: "Dubai", country_name: "United Arab Emirates" }), {
        status: 200,
      }),
    );

    const result = await resolveIpLocation(PUBLIC_IP);
    expect(result).toEqual({
      ok: true,
      location: { city: "Dubai", country: "United Arab Emirates" },
    });
    expect(fetchSpy.mock.calls[0][0]).toContain(PUBLIC_IP);
  });

  it("memoizes, so many rows sharing one address cost one call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ city: "Dubai", country_name: "UAE" }), { status: 200 }),
    );

    await resolveIpLocation(PUBLIC_IP);
    await resolveIpLocation(PUBLIC_IP);
    await resolveIpLocation(PUBLIC_IP);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves a private address to no-location WITHOUT calling out", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // ok:true means the caller stamps geoResolvedAt — never retried.
    expect(await resolveIpLocation("192.168.1.50")).toEqual({
      ok: true,
      location: { city: null, country: null },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves a malformed address to no-location WITHOUT calling out", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(await resolveIpLocation("evil.example.com")).toEqual({
      ok: true,
      location: { city: null, country: null },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("makes no call at all when geo is switched off", async () => {
    process.env.LOGIN_GEO_ENABLED = "false";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(await resolveIpLocation(PUBLIC_IP)).toEqual({ ok: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a non-200 as retryable rather than storing nothing permanently", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
    expect(await resolveIpLocation(PUBLIC_IP)).toEqual({ ok: false });
  });

  it("treats a 200-with-error-flag as a failure, not as real data", async () => {
    // ipapi.co reports quota exhaustion this way; a status check alone would
    // happily store `{city: null, country: null}` forever.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: true, reason: "RateLimited" }), { status: 200 }),
    );
    expect(await resolveIpLocation(PUBLIC_IP)).toEqual({ ok: false });
  });

  it("never throws when the network fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    await expect(resolveIpLocation(PUBLIC_IP)).resolves.toEqual({ ok: false });
  });

  it("never throws on malformed JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>oops", { status: 200 }));
    await expect(resolveIpLocation(PUBLIC_IP)).resolves.toEqual({ ok: false });
  });

  it("normalizes blank provider fields to null instead of empty strings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ city: "   ", country_name: "" }), { status: 200 }),
    );
    expect(await resolveIpLocation(PUBLIC_IP)).toEqual({
      ok: true,
      location: { city: null, country: null },
    });
  });

  it("sends the token as a key parameter when one is configured", async () => {
    process.env.LOGIN_GEO_TOKEN = "sekret";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ city: "Muscat", country_name: "Oman" }), { status: 200 }),
    );

    await resolveIpLocation(PUBLIC_IP);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("key=sekret");
  });
});
