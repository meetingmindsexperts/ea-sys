/**
 * Cancel route — auth/guards/event-access + result→HTTP mapping around the
 * cancelRegistration service (mocked here; the service has its own unit tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, cancelRegistrationSpy } = vi.hoisted(() => ({
  mockDb: { event: { findFirst: vi.fn() } },
  mockAuth: vi.fn(),
  cancelRegistrationSpy: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/services/payment-service", () => ({ cancelRegistration: cancelRegistrationSpy }));
// denyReviewer, denyFinance, buildEventAccessWhere are REAL (pure).

import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/cancel/route";

const params = Promise.resolve({ eventId: "ev1", registrationId: "reg1" });
const req = (body?: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  cancelRegistrationSpy.mockResolvedValue({ ok: true, cancel: { status: "CANCELLED", refunded: true, refund: { amount: 100 } } });
});

describe("cancel route", () => {
  it("cancels + refunds, passes refund flag through, returns the cancel summary", async () => {
    const res = await POST(req({ refund: true }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "CANCELLED", refunded: true });
    expect(cancelRegistrationSpy).toHaveBeenCalledWith(expect.objectContaining({ registrationId: "reg1", eventId: "ev1", refund: true, organizationId: "org1", source: "rest" }));
  });

  it("defaults refund to false when omitted", async () => {
    cancelRegistrationSpy.mockResolvedValue({ ok: true, cancel: { status: "CANCELLED", refunded: false } });
    await POST(req({}), { params });
    expect(cancelRegistrationSpy).toHaveBeenCalledWith(expect.objectContaining({ refund: false }));
  });

  it("maps REFUND_FAILED → 502 with meta", async () => {
    cancelRegistrationSpy.mockResolvedValue({ ok: false, code: "REFUND_FAILED", message: "no", meta: { step: "refund" } });
    const res = await POST(req({ refund: true }), { params });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "REFUND_FAILED", step: "refund" });
  });

  it("maps ALREADY_CANCELLED → 409", async () => {
    cancelRegistrationSpy.mockResolvedValue({ ok: false, code: "ALREADY_CANCELLED", message: "x" });
    expect((await POST(req({ refund: false }), { params })).status).toBe(409);
  });

  it("maps REGISTRATION_NOT_FOUND → 404", async () => {
    cancelRegistrationSpy.mockResolvedValue({ ok: false, code: "REGISTRATION_NOT_FOUND", message: "x" });
    expect((await POST(req({}), { params })).status).toBe(404);
  });

  it("404 when the event is not accessible (service not called)", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await POST(req({ refund: true }), { params });
    expect(res.status).toBe(404);
    expect(cancelRegistrationSpy).not.toHaveBeenCalled();
  });

  it("401 unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(req({}), { params })).status).toBe(401);
  });

  it("403 for MEMBER (denyFinance) and REVIEWER (denyReviewer)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m", role: "MEMBER", organizationId: "org1" } });
    expect((await POST(req({}), { params })).status).toBe(403);
    mockAuth.mockResolvedValue({ user: { id: "r", role: "REVIEWER", organizationId: "org1" } });
    expect((await POST(req({}), { params })).status).toBe(403);
    expect(cancelRegistrationSpy).not.toHaveBeenCalled();
  });

  it("403 for ONSITE (cancel+refund is not a desk action)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "o", role: "ONSITE", organizationId: "org1" } });
    expect((await POST(req({ refund: true }), { params })).status).toBe(403);
  });
});
