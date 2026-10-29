/**
 * POST .../registrations/[registrationId]/onsite-link: the desk's Complete
 * onsite link (docs/ONSITE_DESK_PLAN.md §5.4).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockMint, mockQr } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockMint: vi.fn(),
  mockQr: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/barcode", () => ({ renderQrPng: (...a: unknown[]) => mockQr(...a) }));
vi.mock("@/services/registration-form-service", () => ({ mintOnsiteCompletionLink: (...a: unknown[]) => mockMint(...a) }));

import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/onsite-link/route";

const params = { params: Promise.resolve({ eventId: "evt-1", registrationId: "reg-1" }) };
const call = () => POST(new Request("http://x/onsite-link", { method: "POST" }), params);
const EXPIRES = new Date("2026-10-29T10:30:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", slug: "gcc" });
  mockDb.registration.findFirst.mockResolvedValue({ id: "reg-1", status: "CONFIRMED", userId: null, completedAt: null });
  mockDb.auditLog.create.mockResolvedValue({});
  mockMint.mockResolvedValue({ url: "https://x.test/e/gcc/complete-registration?token=abc", expires: EXPIRES });
  mockQr.mockResolvedValue(Buffer.from("png"));
});

describe("POST onsite-link", () => {
  it("mints a 30-minute link and returns it with a QR code, auditing without the token", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: "https://x.test/e/gcc/complete-registration?token=abc",
      qr: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
      expiresAt: EXPIRES.toISOString(),
    });
    expect(mockMint).toHaveBeenCalledWith(expect.objectContaining({ registrationId: "reg-1", eventSlug: "gcc", minutes: 30 }));
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("ONSITE_COMPLETION_LINK");
    expect(JSON.stringify(audit)).not.toContain("token=");
  });

  it("refuses someone already complete (completedAt or an account) or cancelled, before minting", async () => {
    for (const row of [{ completedAt: new Date() }, { userId: "u-9" }, { status: "CANCELLED" }]) {
      mockDb.registration.findFirst.mockResolvedValueOnce({ id: "reg-1", status: "CONFIRMED", userId: null, completedAt: null, ...row });
      expect((await call()).status).toBe(409);
    }
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("needs a sign-in and an event inside the caller's grant", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(401);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(404);
    mockDb.registration.findFirst.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(404);
    expect(mockMint).not.toHaveBeenCalled();
  });
});
