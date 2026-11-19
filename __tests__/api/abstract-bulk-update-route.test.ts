/**
 * POST abstracts/bulk-update (Nov 19, 2026): the route keeps sign-in, the
 * key, the event the grant reaches, the rate limit and the body's shape; the
 * rules are the service's (abstract-service-bulk-update.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, bulkSpy, rateLimit, logger, gateSpy } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() } },
  bulkSpy: vi.fn(),
  rateLimit: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  gateSpy: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
// The service is real apart from the one function under the route (its limits
// and status list are what the route's schema is built from), so its database
// import is answered here.
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: vi.fn() }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: (...args: unknown[]) => {
    gateSpy(...args);
    return { ok: true, principal: { organizationId: "org1" }, eventWhere: { id: "ev1", organizationId: "org1" } };
  },
}));
vi.mock("@/lib/tenant/event-tenant", () => ({ findGatedEvent: (_gate: unknown, args: unknown) => mockDb.event.findFirst(args) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: rateLimit }));
vi.mock("@/services/abstract-service", async () => {
  const actual = await vi.importActual<typeof import("@/services/abstract-service")>("@/services/abstract-service");
  return { ...actual, bulkUpdateAbstracts: bulkSpy };
});

import { POST } from "@/app/api/events/[eventId]/abstracts/bulk-update/route";

const post = (body: unknown) =>
  POST(new Request("http://x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ eventId: "ev1" }) });
const DONE = { ok: true, changed: ["a1"], unchanged: [], skipped: [], remaining: [], emailed: 0, emailFailed: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  rateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  bulkSpy.mockResolvedValue(DONE);
});

describe("POST abstracts/bulk-update", () => {
  it("asks the key the single change asks, and hands the service what was sent", async () => {
    const res = await post({ abstractIds: ["a1", "a2"], status: "ACCEPTED", presentationType: "POSTER", notifyAuthors: true, forceStatus: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DONE);
    expect(gateSpy.mock.calls[0][1]).toBe("abstracts.update");
    expect(bulkSpy).toHaveBeenCalledWith({
      eventId: "ev1", organizationId: "org1", userId: "u1",
      abstractIds: ["a1", "a2"], status: "ACCEPTED", presentationType: "POSTER",
      notifyAuthors: true, forceStatus: true, source: "rest", requestIp: "1.2.3.4",
    });
  });

  it("authors are not emailed and nothing is overridden unless the body says so", async () => {
    await post({ abstractIds: ["a1"], status: "REJECTED" });
    expect(bulkSpy.mock.calls[0][0]).toMatchObject({ notifyAuthors: false, forceStatus: false });
  });

  it("refuses a body with neither a status nor a type, no ids, a status staff cannot set, an unknown field, or one that is not JSON", async () => {
    for (const body of [
      { abstractIds: ["a1"] },
      { abstractIds: [], status: "ACCEPTED" },
      { abstractIds: ["a1"], status: "SUBMITTED" },
      { abstractIds: ["a1"], status: "DRAFT" },
      { abstractIds: ["a1"], presentationType: "HOLOGRAM" },
      { abstractIds: ["a1"], status: "ACCEPTED", everything: true },
      { abstractIds: Array.from({ length: 501 }, (_, i) => `a${i}`), status: "ACCEPTED" },
      "not json",
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(bulkSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "abstracts/bulk-update:zod-validation-failed" }));
  });

  it("401 signed out, 404 for an event the grant does not reach, 429 over the limit: each logged, nothing changed", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await post({ abstractIds: ["a1"], status: "ACCEPTED" })).status).toBe(401);

    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await post({ abstractIds: ["a1"], status: "ACCEPTED" })).status).toBe(404);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "abstracts/bulk-update:event-not-found" }));

    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 90 });
    const limited = await post({ abstractIds: ["a1"], status: "ACCEPTED" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("90");
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 90, limit: 60, windowSeconds: 3600 });
    expect(bulkSpy).not.toHaveBeenCalled();
  });

  it("a refusal from the service keeps its code and gets its status", async () => {
    bulkSpy.mockResolvedValueOnce({ ok: false, code: "TYPE_NOT_OFFERED", message: "This event does not offer VIDEO presentations." });
    const res = await post({ abstractIds: ["a1"], presentationType: "VIDEO" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "This event does not offer VIDEO presentations.", code: "TYPE_NOT_OFFERED" });

    bulkSpy.mockResolvedValueOnce({ ok: false, code: "UNKNOWN", message: "Failed to update the abstracts" });
    expect((await post({ abstractIds: ["a1"], status: "ACCEPTED" })).status).toBe(500);
  });

  it("a throw is a logged 500", async () => {
    bulkSpy.mockRejectedValueOnce(new Error("boom"));
    expect((await post({ abstractIds: ["a1"], status: "ACCEPTED" })).status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "abstracts/bulk-update:failed" }));
  });
});
