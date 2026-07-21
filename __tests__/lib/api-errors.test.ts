/**
 * rateLimited() — the canonical 429 (duplication-audit finding 6). Pins the
 * documented rate-limit contract: RFC-9110 Retry-After header, RATE_LIMITED
 * code + retryAfterSeconds in the body, optional limit/windowSeconds echo,
 * and a warn log on every rejection (no silent 429s).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockApiLogger } = vi.hoisted(() => ({
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import { rateLimited } from "@/lib/api-errors";

beforeEach(() => vi.clearAllMocks());

describe("rateLimited", () => {
  it("sets the Retry-After header and the canonical body", async () => {
    const res = rateLimited({ retryAfterSeconds: 42 }, { route: "test/route" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    const body = await res.json();
    expect(body).toEqual({
      error: "Too many requests. Please try again in 42 seconds.",
      code: "RATE_LIMITED",
      retryAfterSeconds: 42,
    });
  });

  it("echoes limit/windowSeconds and honors a custom message", async () => {
    const res = rateLimited(
      { retryAfterSeconds: 7 },
      { route: "test/route", message: "Slow down", limit: 20, windowSeconds: 3600 },
    );
    const body = await res.json();
    expect(body).toEqual({
      error: "Slow down",
      code: "RATE_LIMITED",
      retryAfterSeconds: 7,
      limit: 20,
      windowSeconds: 3600,
    });
  });

  it("warn-logs the rejection with route + threaded context, excluding body-only fields", () => {
    rateLimited({ retryAfterSeconds: 9 }, { route: "test/route", ip: "1.2.3.4", message: "x", limit: 5 });
    expect(mockApiLogger.warn).toHaveBeenCalledWith({
      msg: "test/route:rate-limited",
      retryAfterSeconds: 9,
      route: "test/route",
      ip: "1.2.3.4",
    });
  });
});
