/**
 * The single LoginEvent writer.
 *
 * The load-bearing property is the CONTRACT: recording a sign-in must never be
 * able to prevent one. If this function can throw, a database blip locks every
 * user out of the product — which would be a far worse outage than losing the
 * security trail it exists to keep.
 *
 * The rest is normalization, so that reading the history back groups one
 * subject together rather than scattering them across casings.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: { loginEvent: { create: vi.fn() } },
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ authLogger: mockLogger, apiLogger: mockLogger }));

import { recordLoginEvent, readUserAgent } from "@/lib/login-audit";

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.loginEvent.create.mockResolvedValue({ id: "le-1" });
});

describe("recordLoginEvent — never breaks sign-in", () => {
  it("swallows a database failure and logs it instead of throwing", async () => {
    mockDb.loginEvent.create.mockRejectedValue(new Error("pool timeout"));

    await expect(
      recordLoginEvent({
        email: "a@b.com",
        outcome: "SUCCESS",
        surface: "DASHBOARD",
      }),
    ).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "login-audit:write-failed" }),
    );
  });
});

describe("recordLoginEvent — normalization", () => {
  it("lowercases and trims the address so one person is one subject", async () => {
    await recordLoginEvent({
      email: "  Admin@Example.COM  ",
      outcome: "FAILED_PASSWORD",
      surface: "DASHBOARD",
    });

    expect(mockDb.loginEvent.create.mock.calls[0][0].data.email).toBe("admin@example.com");
  });

  it("stores nulls rather than undefined for an unattributed attempt", async () => {
    await recordLoginEvent({
      email: "ghost@example.com",
      outcome: "FAILED_UNKNOWN_EMAIL",
      surface: "EVENT_PAGE",
    });

    const data = mockDb.loginEvent.create.mock.calls[0][0].data;
    expect(data.userId).toBeNull();
    expect(data.organizationId).toBeNull();
    expect(data.ipAddress).toBeNull();
    expect(data.userAgent).toBeNull();
  });

  it("caps an oversized address so the column can't be used as free storage", async () => {
    await recordLoginEvent({
      email: `${"x".repeat(500)}@example.com`,
      outcome: "FAILED_UNKNOWN_EMAIL",
      surface: "MOBILE",
    });

    expect(mockDb.loginEvent.create.mock.calls[0][0].data.email.length).toBeLessThanOrEqual(320);
  });

  it("caps an oversized user-agent", async () => {
    await recordLoginEvent({
      email: "a@b.com",
      outcome: "SUCCESS",
      surface: "MOBILE",
      userAgent: "U".repeat(5000),
    });

    expect(
      mockDb.loginEvent.create.mock.calls[0][0].data.userAgent.length,
    ).toBeLessThanOrEqual(1000);
  });

  it("carries attribution through when the account is known", async () => {
    await recordLoginEvent({
      email: "admin@example.com",
      outcome: "SUCCESS",
      surface: "DASHBOARD",
      userId: "user-1",
      organizationId: "org-1",
      ipAddress: "203.0.113.7",
      userAgent: "Mozilla/5.0",
    });

    expect(mockDb.loginEvent.create.mock.calls[0][0].data).toMatchObject({
      userId: "user-1",
      organizationId: "org-1",
      ipAddress: "203.0.113.7",
      outcome: "SUCCESS",
      surface: "DASHBOARD",
    });
  });
});

describe("readUserAgent", () => {
  it("reads the header when present", () => {
    const req = new Request("http://x/", { headers: { "user-agent": "Firefox/1" } });
    expect(readUserAgent(req)).toBe("Firefox/1");
  });

  it("returns null rather than throwing on an absent or odd request", () => {
    expect(readUserAgent(new Request("http://x/"))).toBeNull();
    expect(readUserAgent(undefined)).toBeNull();
    expect(readUserAgent(null)).toBeNull();
  });
});
