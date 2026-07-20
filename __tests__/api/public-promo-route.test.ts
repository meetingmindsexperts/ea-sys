/**
 * Tests for the public promo apply/remove route
 *   POST/DELETE /api/public/events/[slug]/registrations/[registrationId]/promo
 * — the "organizer emailed a code after registration" flow on the public
 * confirmation page. No auth: trust = unguessable registration id BOUND to the
 * event slug (the /document route's model), per-IP rate limit, and all promo
 * rules enforced by the shared promo-code-service.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApply, mockRemove, mockCheckRateLimit } = vi.hoisted(() => ({
  mockDb: { registration: { findFirst: vi.fn() } },
  mockApply: vi.fn(),
  mockRemove: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/security", () => ({
  getClientIp: vi.fn().mockReturnValue("1.2.3.4"),
  checkRateLimit: (args: unknown) => mockCheckRateLimit(args),
}));
vi.mock("@/services/promo-code-service", () => ({
  applyPromoCodeToRegistration: (args: unknown) => mockApply(args),
  removePromoCodeFromRegistration: (args: unknown) => mockRemove(args),
}));

import { POST, DELETE } from "@/app/api/public/events/[slug]/registrations/[registrationId]/promo/route";

const params = { params: Promise.resolve({ slug: "BHS2026", registrationId: "reg-1" }) };

function postReq(body?: Record<string, unknown>) {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "not-json" : JSON.stringify(body),
  });
}
const delReq = () => new Request("http://localhost/api/x", { method: "DELETE" });

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockReturnValue({ allowed: true, remaining: 19, retryAfterSeconds: 3600 });
  mockDb.registration.findFirst.mockResolvedValue({ id: "reg-1", eventId: "evt-1" });
  mockApply.mockResolvedValue({
    ok: true,
    financials: { code: "SAVE50", originalPrice: 150, discountAmount: 75, finalPrice: 75, currency: "USD" },
    replaced: false,
  });
  mockRemove.mockResolvedValue({ ok: true, removed: true });
});

describe("POST public promo apply", () => {
  it("applies via the shared service with source 'public' and slug-bound event", async () => {
    const res = await POST(postReq({ code: "SAVE50" }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.finalPrice).toBe(75);
    // The registration must be resolved slug-bound, never by id alone.
    expect(mockDb.registration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reg-1", event: { slug: "BHS2026" } } }),
    );
    expect(mockApply).toHaveBeenCalledWith({
      registrationId: "reg-1",
      eventId: "evt-1",
      code: "SAVE50",
      source: "public",
    });
  });

  it("404 when the id does not belong to the slug's event", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await POST(postReq({ code: "SAVE50" }), params);
    expect(res.status).toBe(404);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("429 when rate-limited, before touching the DB", async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 120 });
    const res = await POST(postReq({ code: "SAVE50" }), params);
    expect(res.status).toBe(429);
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("400 on a missing/invalid body", async () => {
    const res = await POST(postReq({}), params);
    expect(res.status).toBe(400);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("maps service rejections to their HTTP status", async () => {
    for (const [code, status] of [
      ["INVALID_CODE", 400],
      ["ALREADY_SETTLED", 400],
      ["EXHAUSTED", 400],
      ["EMAIL_LIMIT", 400],
      ["REGISTRATION_NOT_FOUND", 404],
      ["UNKNOWN", 500],
    ] as const) {
      mockApply.mockResolvedValueOnce({ ok: false, code, message: "nope" });
      const res = await POST(postReq({ code: "X" }), params);
      expect(res.status).toBe(status);
      expect((await res.json()).code).toBe(code);
    }
  });
});

describe("DELETE public promo remove", () => {
  it("removes via the shared service with source 'public'", async () => {
    const res = await DELETE(delReq(), params);
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(true);
    expect(mockRemove).toHaveBeenCalledWith({ registrationId: "reg-1", eventId: "evt-1", source: "public" });
  });

  it("404 when the id does not belong to the slug's event", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await DELETE(delReq(), params);
    expect(res.status).toBe(404);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("429 when rate-limited", async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 120 });
    const res = await DELETE(delReq(), params);
    expect(res.status).toBe(429);
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
