/**
 * POST abstracts/make-presenters (Nov 20, 2026; plan step 4): the route keeps
 * sign-in, the keys (it changes registrations, so the bulk action's key, and
 * abstracts must be readable on THIS event), the event the grant reaches, the
 * rate limit and the body's shape. The rules are the service's.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, makeSpy, rateLimit, logger, gateSpy, canSpy } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() } },
  makeSpy: vi.fn(),
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
vi.mock("@/services/presenter-service", () => ({ makePresenters: makeSpy }));
vi.mock("@/services/registration-bulk-service", () => ({ MAX_BULK_REGISTRATION_UPDATES: 500 }));

import { POST } from "@/app/api/events/[eventId]/abstracts/make-presenters/route";

const post = (body: unknown) =>
  POST(new Request("http://x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ eventId: "ev1" }) });
const DONE = { ok: true, made: ["a1"], already: [], skipped: [], noRegistration: [], notAccepted: [], remaining: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", eventType: "CONFERENCE", staffAssignments: [] });
  rateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  canSpy.mockReturnValue(true);
  makeSpy.mockResolvedValue(DONE);
});

describe("POST abstracts/make-presenters", () => {
  it("asks the bulk registrations key, and hands the service the abstracts", async () => {
    const res = await post({ abstractIds: ["a1", "a2"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DONE);
    expect(gateSpy.mock.calls[0][1]).toBe("registrations.bulk");
    expect(makeSpy).toHaveBeenCalledWith({ eventId: "ev1", organizationId: "org1", actorUserId: "u1", abstractIds: ["a1", "a2"], source: "rest", requestIp: "1.2.3.4" });
  });

  it("abstracts must be readable on THIS event: otherwise 403, logged, and nothing runs", async () => {
    canSpy.mockReturnValue(false);
    const res = await post({ abstractIds: ["a1"] });
    expect(res.status).toBe(403);
    expect(canSpy.mock.calls[0][1]).toBe("abstracts.read");
    expect(canSpy.mock.calls[0][2]).toMatchObject({ event: { organizationId: "org1", eventType: "CONFERENCE" } });
    expect(makeSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "abstracts/make-presenters:abstracts-not-readable" }));
  });

  it("it sets a payment status and a badge, so it needs the edit key on this event too", async () => {
    canSpy.mockImplementation((_p: unknown, key: string) => key !== "registrations.update");
    const res = await post({ abstractIds: ["a1"] });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("UPDATE_NOT_PERMITTED");
    expect(makeSpy).not.toHaveBeenCalled();
  });

  it("refuses no ids, an unknown field, or a body that is not JSON; 401 signed out; 404 off the grant; 429 limited", async () => {
    for (const body of [{ abstractIds: [] }, { abstractIds: ["a1"], paymentStatus: "PAID" }, {}, "not json"]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "abstracts/make-presenters:zod-validation-failed" }));

    mockAuth.mockResolvedValueOnce(null);
    expect((await post({ abstractIds: ["a1"] })).status).toBe(401);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await post({ abstractIds: ["a1"] })).status).toBe(404);
    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 30 });
    const limited = await post({ abstractIds: ["a1"] });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("30");
    expect(makeSpy).not.toHaveBeenCalled();
  });

  it("maps the service's refusal and logs it; a throw is a 500 that is logged", async () => {
    makeSpy.mockResolvedValueOnce({ ok: false, code: "TOO_MANY", message: "Too many" });
    expect((await post({ abstractIds: ["a1"] })).status).toBe(400);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "abstracts/make-presenters:rejected", code: "TOO_MANY" }));
    makeSpy.mockRejectedValueOnce(new Error("boom"));
    expect((await post({ abstractIds: ["a1"] })).status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "abstracts/make-presenters:failed" }));
  });
});
