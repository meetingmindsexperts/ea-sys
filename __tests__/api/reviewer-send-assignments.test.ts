/**
 * Assignment emails are sent by hand (owner, Nov 10, 2026): "Send assignments"
 * emails each reviewer with something unsent on THIS event once, and removing
 * a reviewer takes their assignments on the event with them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, sendPending, updateEventSettings } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstractReviewer: { findMany: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  sendPending: vi.fn(),
  updateEventSettings: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({
  auth: () => Promise.resolve({ user: { id: "admin1", role: "ORGANIZER", organizationId: "org1" } }),
}));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: () => ({ ok: true, eventWhere: { id: "ev1", organizationId: "org1" } }),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/abstract-reviewer-notify", () => ({ sendPendingAssignments: sendPending }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings }));

import { POST as send } from "@/app/api/events/[eventId]/reviewers/send-assignments/route";
import { DELETE as remove } from "@/app/api/events/[eventId]/reviewers/[reviewerId]/route";

const post = (body: unknown) =>
  send(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ eventId: "ev1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: { reviewerUserIds: ["r1", "r2"] } });
  mockDb.abstractReviewer.findMany.mockResolvedValue([{ userId: "r1" }, { userId: "r2" }]);
  sendPending.mockResolvedValue({ ok: true, sent: 3 });
});

describe("POST send-assignments", () => {
  it("emails every reviewer with something unsent on this event, once each", async () => {
    const res = await post({});
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ emailed: 2, failed: 0 });
    expect(sendPending).toHaveBeenCalledTimes(2);
    expect(sendPending).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1", reviewerUserId: "r1", triggeredByUserId: "admin1" }));
    expect(mockDb.abstractReviewer.findMany.mock.calls[0][0]).toMatchObject({
      where: { notifiedAt: null, abstract: { eventId: "ev1" } },
      distinct: ["userId"],
    });
  });

  it("only the reviewers named, and only on this event", async () => {
    mockDb.abstractReviewer.findMany.mockResolvedValue([{ userId: "r1" }]);
    await post({ reviewerIds: ["r1"] });
    expect(mockDb.abstractReviewer.findMany.mock.calls[0][0].where).toEqual({ notifiedAt: null, abstract: { eventId: "ev1" }, userId: { in: ["r1"] } });
    expect(sendPending).toHaveBeenCalledTimes(1);
  });

  it("reports a failed send and does not count 'nothing pending' as a failure", async () => {
    sendPending
      .mockResolvedValueOnce({ ok: false, code: "SEND_FAILED", message: "refused" })
      .mockResolvedValueOnce({ ok: false, code: "NOTHING_PENDING", message: "nothing" });
    const body = await (await post({})).json();
    expect(body).toMatchObject({ emailed: 0, failed: 1 });
  });

  it("refuses a bad body and an event out of reach", async () => {
    expect((await post({ reviewerIds: "r1" })).status).toBe(400);
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await post({})).status).toBe(404);
    expect(sendPending).not.toHaveBeenCalled();
  });
});

describe("DELETE a reviewer", () => {
  it("takes them off the pool AND off every abstract assigned to them on this event", async () => {
    mockDb.abstractReviewer.deleteMany.mockResolvedValue({ count: 4 });
    const res = await remove(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ eventId: "ev1", reviewerId: "r1" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, assignmentsRemoved: 4 });
    expect(updateEventSettings).toHaveBeenCalledTimes(1);
    expect(mockDb.abstractReviewer.deleteMany).toHaveBeenCalledWith({ where: { userId: "r1", abstract: { eventId: "ev1" } } });
  });
});
