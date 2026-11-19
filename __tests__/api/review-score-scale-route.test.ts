/**
 * review-criteria/scale (Nov 19, 2026): what a criterion is scored out of, 5,
 * 10 or 100, and the rule that a submitted review fixes it. Stored criterion
 * scores are raw numbers on the scale they were given on and nothing converts
 * them, so a change after reviewing started would re-mean every score.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, settingsSpy, logger, gateSpy } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    abstractReviewSubmission: { count: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  settingsSpy: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  gateSpy: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
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
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: settingsSpy }));

import { GET, PUT } from "@/app/api/events/[eventId]/review-criteria/scale/route";

const ctx = { params: Promise.resolve({ eventId: "ev1" }) };
const get = () => GET(new Request("http://x"), ctx);
const put = (body: unknown) => PUT(new Request("http://x", { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body) }), ctx);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: {} });
  mockDb.abstractReviewSubmission.count.mockResolvedValue(0);
  mockDb.auditLog.create.mockReturnValue(Promise.resolve({}));
  settingsSpy.mockResolvedValue({});
});

describe("GET review-criteria/scale", () => {
  it("an event that never chose is on 0 to 10, and free to change while no review is in", async () => {
    expect(await (await get()).json()).toEqual({ scale: 10, locked: false, reviewCount: 0 });
    expect(mockDb.abstractReviewSubmission.count).toHaveBeenCalledWith({ where: { abstract: { eventId: "ev1" } } });
  });

  it("the saved scale, locked once a review is in", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: { reviewScoreScale: 5 } });
    mockDb.abstractReviewSubmission.count.mockResolvedValue(3);
    expect(await (await get()).json()).toEqual({ scale: 5, locked: true, reviewCount: 3 });
  });

  it("401 signed out, 404 for an event the grant does not reach", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(404);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "review-score-scale:event-not-found" }));
  });
});

describe("PUT review-criteria/scale", () => {
  it("saves a new scale while no review is in, with the criteria key, and audits it", async () => {
    const res = await put({ scale: 5 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scale: 5, locked: false, reviewCount: 0 });
    expect(gateSpy.mock.calls[0][1]).toBe("abstracts.criteria.manage");
    expect(settingsSpy).toHaveBeenCalledWith("ev1", { reviewScoreScale: 5 }, { organizationId: "org1" });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ before: { reviewScoreScale: 10 }, after: { reviewScoreScale: 5 } });
  });

  it("once a review is in, the scale is fixed: 409 with the reason, nothing written", async () => {
    mockDb.abstractReviewSubmission.count.mockResolvedValue(2);
    const res = await put({ scale: 100 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "SCALE_LOCKED", scale: 10, reviewCount: 2, error: expect.stringContaining("2 reviews on the 0 to 10 scale") });
    expect(settingsSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "review-score-scale:locked", requested: 100 }));
  });

  it("saving the scale it already has changes nothing and is never refused, locked or not", async () => {
    mockDb.abstractReviewSubmission.count.mockResolvedValue(2);
    const res = await put({ scale: 10 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scale: 10, locked: true, reviewCount: 2 });
    expect(settingsSpy).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses a scale that is not 5, 10 or 100, an unknown field and a body that is not JSON", async () => {
    for (const body of [{ scale: 7 }, { scale: "5" }, { scale: 5.5 }, {}, { scale: 5, force: true }, "not json"]) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID_SCALE" });
    }
    expect(settingsSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "review-score-scale:invalid-input" }));
  });

  it("401 signed out, 404 for an event the grant does not reach, and a throw is a logged 500", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await put({ scale: 5 })).status).toBe(401);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await put({ scale: 5 })).status).toBe(404);
    settingsSpy.mockRejectedValueOnce(new Error("db down"));
    expect((await put({ scale: 5 })).status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "review-score-scale:PUT failed" }));
  });
});
