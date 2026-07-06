/**
 * Per-event ONSITE assignment route. Pins the lifecycle the org tab relies on:
 * assigning appends the user to Event.settings.onsiteUserIds (→ they gain access
 * to ONLY that event via buildEventAccessWhere), unassigning removes them (→
 * they lose access to that event). Plus the org-scoping guards: the target must
 * be an ONSITE account in the caller's org, and restricted roles can't manage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, updateEventSettingsSpy } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockAuth: vi.fn(),
  updateEventSettingsSpy: vi.fn().mockResolvedValue({}),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: updateEventSettingsSpy }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));

import { POST, DELETE } from "@/app/api/events/[eventId]/onsite-staff/route";

const params = Promise.resolve({ eventId: "ev1" });
type PatchFn = (cur: Record<string, unknown>) => Record<string, unknown>;

function postReq(body: Record<string, unknown>) {
  return new Request("http://localhost/api/events/ev1/onsite-staff", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.user.findFirst.mockResolvedValue({ id: "onsite1" });
});

describe("POST /events/[id]/onsite-staff — assign a temp to an event", () => {
  it("appends the user to onsiteUserIds (dedup, preserves other keys)", async () => {
    const res = await POST(postReq({ userId: "onsite1" }), { params });
    expect(res.status).toBeLessThan(400);
    expect(updateEventSettingsSpy).toHaveBeenCalledTimes(1);
    const patch = updateEventSettingsSpy.mock.calls[0][1] as PatchFn;
    expect(patch({ onsiteUserIds: ["x"], foo: 1 })).toEqual({ onsiteUserIds: ["x", "onsite1"], foo: 1 });
    expect(patch({})).toEqual({ onsiteUserIds: ["onsite1"] });
    expect(patch({ onsiteUserIds: ["onsite1"] })).toEqual({ onsiteUserIds: ["onsite1"] }); // no dup
  });

  it("404 when the target is not an ONSITE account in the caller's org", async () => {
    mockDb.user.findFirst.mockResolvedValue(null);
    const res = await POST(postReq({ userId: "nope" }), { params });
    expect(res.status).toBe(404);
    expect(updateEventSettingsSpy).not.toHaveBeenCalled();
  });

  it("404 when the event is not in the caller's org", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await POST(postReq({ userId: "onsite1" }), { params });
    expect(res.status).toBe(404);
  });

  it("401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(postReq({ userId: "onsite1" }), { params });
    expect(res.status).toBe(401);
  });

  it("403 for a restricted role (MEMBER can't manage onsite staff)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", organizationId: "org1" } });
    const res = await POST(postReq({ userId: "onsite1" }), { params });
    expect(res.status).toBe(403);
  });

  it("400 on invalid body", async () => {
    const res = await POST(postReq({}), { params });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /events/[id]/onsite-staff — remove a temp from an event", () => {
  it("removes the user from onsiteUserIds (they lose access to that event)", async () => {
    const req = new Request("http://localhost/api/events/ev1/onsite-staff?userId=onsite1", { method: "DELETE" });
    const res = await DELETE(req, { params });
    expect(res.status).toBeLessThan(400);
    const patch = updateEventSettingsSpy.mock.calls[0][1] as PatchFn;
    expect(patch({ onsiteUserIds: ["onsite1", "keep"] })).toEqual({ onsiteUserIds: ["keep"] });
  });

  it("400 when userId is missing", async () => {
    const req = new Request("http://localhost/api/events/ev1/onsite-staff", { method: "DELETE" });
    const res = await DELETE(req, { params });
    expect(res.status).toBe(400);
  });
});
