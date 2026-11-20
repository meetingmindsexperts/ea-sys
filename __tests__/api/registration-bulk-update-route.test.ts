/**
 * POST registrations/bulk-update (Nov 20, 2026): the route keeps sign-in, the
 * keys, the event the grant reaches, the rate limit and the body's shape; the
 * rules are the service's (registration-bulk-service.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, bulkSpy, rateLimit, logger, gateSpy, canSpy } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() } },
  bulkSpy: vi.fn(),
  rateLimit: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  gateSpy: vi.fn(),
  canSpy: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: vi.fn() }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: (...args: unknown[]) => {
    gateSpy(...args);
    return { ok: true, principal: { organizationId: "org1" }, eventWhere: { id: "ev1", organizationId: "org1" } };
  },
}));
vi.mock("@/lib/permissions/can", () => ({ can: (...args: unknown[]) => canSpy(...args) }));
vi.mock("@/lib/tenant/event-tenant", () => ({ findGatedEvent: (_gate: unknown, args: unknown) => mockDb.event.findFirst(args) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: rateLimit }));
vi.mock("@/services/registration-bulk-service", async () => {
  const actual = await vi.importActual<typeof import("@/services/registration-bulk-service")>("@/services/registration-bulk-service");
  return { ...actual, bulkUpdateRegistrations: bulkSpy };
});
// The real service module imports these; the route never reaches them.
vi.mock("@/services/registration-service", () => ({ updateRegistration: vi.fn() }));
vi.mock("@/services/payment-service", () => ({ cancelRegistration: vi.fn() }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));

import { POST } from "@/app/api/events/[eventId]/registrations/bulk-update/route";

const post = (body: unknown) =>
  POST(new Request("http://x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ eventId: "ev1" }) });
const DONE = { ok: true, changed: ["r1"], unchanged: [], skipped: [], remaining: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  rateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  canSpy.mockReturnValue(true);
  bulkSpy.mockResolvedValue(DONE);
});

describe("POST registrations/bulk-update", () => {
  it("asks the bulk key, and hands the service what was sent", async () => {
    const res = await post({ registrationIds: ["r1", "r2"], paymentStatus: "COMPLIMENTARY", badgeType: " Presenter " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DONE);
    expect(gateSpy.mock.calls[0][1]).toBe("registrations.bulk");
    expect(bulkSpy).toHaveBeenCalledWith({
      eventId: "ev1", organizationId: "org1", actorUserId: "u1",
      registrationIds: ["r1", "r2"], paymentStatus: "COMPLIMENTARY", badgeType: "Presenter", cancel: false,
      source: "rest", requestIp: "1.2.3.4",
    });
  });

  it("a cancel also needs the Cancel button's key: without it, 403, logged, and nothing runs", async () => {
    canSpy.mockReturnValue(false);
    const res = await post({ registrationIds: ["r1"], cancel: true });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("CANCEL_NOT_PERMITTED");
    expect(canSpy.mock.calls[0][1]).toBe("registrations.cancel");
    expect(bulkSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "registrations/bulk-update:cancel-not-permitted" }));
    // A payment status or a badge asks for no second key.
    canSpy.mockClear();
    expect((await post({ registrationIds: ["r1"], badgeType: "Presenter" })).status).toBe(200);
    expect(canSpy).not.toHaveBeenCalled();
  });

  it("refuses: nothing to change, no ids, Paid or Inclusive in bulk, a cancel mixed with another change, an unknown field, not JSON", async () => {
    for (const body of [
      { registrationIds: ["r1"] },
      { registrationIds: [], badgeType: "Presenter" },
      { registrationIds: ["r1"], paymentStatus: "PAID" },
      { registrationIds: ["r1"], paymentStatus: "INCLUSIVE" },
      { registrationIds: ["r1"], paymentStatus: "REFUNDED" },
      { registrationIds: ["r1"], cancel: true, paymentStatus: "COMPLIMENTARY" },
      { registrationIds: ["r1"], cancel: false },
      { registrationIds: ["r1"], badgeType: "Presenter", status: "CANCELLED" },
      "not json",
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(bulkSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "registrations/bulk-update:zod-validation-failed" }));
  });

  it("401 signed out; 404 for an event the grant does not reach; 429 when rate limited, with Retry-After", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await post({ registrationIds: ["r1"], badgeType: "X" })).status).toBe(401);

    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await post({ registrationIds: ["r1"], badgeType: "X" })).status).toBe(404);

    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 90 });
    const limited = await post({ registrationIds: ["r1"], badgeType: "X" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("90");
    expect((await limited.json()).retryAfterSeconds).toBe(90);
    expect(bulkSpy).not.toHaveBeenCalled();
  });

  it("maps the service's refusals, and a throw is a 500 that is logged", async () => {
    bulkSpy.mockResolvedValueOnce({ ok: false, code: "TOO_MANY", message: "Too many" });
    expect((await post({ registrationIds: ["r1"], badgeType: "X" })).status).toBe(400);
    bulkSpy.mockRejectedValueOnce(new Error("boom"));
    expect((await post({ registrationIds: ["r1"], badgeType: "X" })).status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "registrations/bulk-update:failed" }));
  });
});
