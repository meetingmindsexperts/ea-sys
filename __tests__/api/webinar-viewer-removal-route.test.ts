/**
 * PUT /api/events/{eventId}/webinar/viewers/{registrationId} (Nov 25, 2026): remove a viewer from
 * this webinar, or let them back. Block this webinar only: the registration's status, payment and
 * certificates are never touched; only the two removal columns change.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, permSpy, mockLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  permSpy: vi.fn(),
  mockLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => mockLimit() }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: (_s: unknown, key: string) => permSpy(key),
}));

import { PUT } from "@/app/api/events/[eventId]/webinar/viewers/[registrationId]/route";

const ADMIN = { user: { id: "u1", role: "ADMIN", organizationId: "org1" } };
const put = (body: unknown) => PUT(new Request("http://t/x", { method: "PUT", body: JSON.stringify(body) }), {
  params: Promise.resolve({ eventId: "ev1", registrationId: "reg1" }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(ADMIN);
  permSpy.mockReturnValue({ ok: true, principal: { organizationId: "org1", baseRole: "ADMIN", fromApiKey: false }, eventWhere: { id: "ev1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", eventType: "WEBINAR" });
  mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
  mockDb.auditLog.create.mockReturnValue(Promise.resolve({}));
});

describe("removing a webinar viewer", () => {
  it("asks webinar.manage, stamps who and when on THIS event's registration only, and audits it", async () => {
    const res = await put({ removed: true });
    expect(res.status).toBe(200);
    expect(permSpy).toHaveBeenCalledWith("webinar.manage");
    const call = mockDb.registration.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "reg1", eventId: "ev1" });
    expect(Object.keys(call.data).sort()).toEqual(["webinarRemovedAt", "webinarRemovedById"]);
    expect(call.data.webinarRemovedById).toBe("u1");
    expect(call.data.webinarRemovedAt).toBeInstanceOf(Date);
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "WEBINAR_VIEWER_REMOVED", entityId: "reg1", organizationId: "org1" }) }),
    );
  });

  it("letting them back clears both columns and nothing else", async () => {
    const res = await put({ removed: false });
    expect(res.status).toBe(200);
    expect(mockDb.registration.updateMany.mock.calls[0][0].data).toEqual({ webinarRemovedAt: null, webinarRemovedById: null });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "WEBINAR_VIEWER_RESTORED" }) }));
  });

  it("a registration of another event is not found, never touched", async () => {
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
    expect((await put({ removed: true })).status).toBe(404);
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses: no session, no permission, an event out of reach, a conference, a bad body, too many", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await put({ removed: true })).status).toBe(401);
    permSpy.mockReturnValueOnce({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await put({ removed: true })).status).toBe(403);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await put({ removed: true })).status).toBe(404);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "ev1", eventType: "CONFERENCE" });
    expect((await put({ removed: true })).status).toBe(409);
    expect((await put({ removed: "yes" })).status).toBe(400);
    expect((await put({ removed: true, status: "CANCELLED" })).status).toBe(400);
    mockLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 60 });
    const limited = await put({ removed: true });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED", limit: 120, windowSeconds: 3600 });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });
});
