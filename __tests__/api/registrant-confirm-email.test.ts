/**
 * /api/registrant/confirm-email: a signed-in person asks for a link to their
 * OWN address (Nov 5, 2026). The address comes from the database, never the
 * request, and sending is rate limited.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockSend, mockRateLimit, mockWarn } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { user: { findUnique: vi.fn() } },
  mockSend: vi.fn(),
  mockRateLimit: vi.fn(),
  mockWarn: vi.fn(),
}));
vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: mockWarn, error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: mockRateLimit }));
vi.mock("@/lib/email-verification", () => ({ sendEmailVerification: mockSend }));
vi.mock("@/lib/tenant/resolver", () => ({ resolveRequestOrgId: vi.fn(async () => null) }));
vi.mock("@/lib/tenant-lane", () => ({ runWithTenantLane: (_o: unknown, _c: unknown, fn: () => unknown) => fn() }));

import { GET, POST } from "@/app/api/registrant/confirm-email/route";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", email: "spoofed@evil.com" } });
  mockDb.user.findUnique.mockResolvedValue({ email: "anna@example.com", firstName: "Anna", lastName: "K", emailConfirmedAt: null });
  mockRateLimit.mockReturnValue({ allowed: true });
});

describe("POST /api/registrant/confirm-email", () => {
  it("sends the link to the account's own address from the database, with the registrations wording", async () => {
    const res = await POST(new Request("http://x", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledWith({ email: "anna@example.com", name: "Anna K", purpose: "registrations" });
  });

  it("sends nothing to an account already confirmed", async () => {
    mockDb.user.findUnique.mockResolvedValue({ email: "anna@example.com", firstName: "Anna", lastName: "K", emailConfirmedAt: new Date() });
    expect(await (await POST(new Request("http://x", { method: "POST" }))).json()).toEqual({ confirmed: true, sent: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("is rate limited per account, with Retry-After and a logged warning", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 600 });
    const res = await POST(new Request("http://x", { method: "POST" }));
    expect(res.status).toBe(429);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockRateLimit).toHaveBeenCalledWith(expect.objectContaining({ key: "registrant-confirm-email:u1" }));
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ msg: "registrant/confirm-email:rate-limited" }));
  });

  it("refuses a signed-out request", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(new Request("http://x", { method: "POST" }))).status).toBe(401);
  });
});

describe("GET /api/registrant/confirm-email", () => {
  it("says whether the account's address is confirmed", async () => {
    expect(await (await GET(new Request("http://x"))).json()).toEqual({ confirmed: false, email: "anna@example.com" });
  });
});
