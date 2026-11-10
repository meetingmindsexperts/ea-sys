/**
 * Assignment emails are sent by hand (owner, Nov 10, 2026): "Send assignments"
 * emails each reviewer ON THE POOL with something sendable on THIS event once,
 * in short requests the client chains, and removing a reviewer takes their
 * assignments on the event with them (assignments first, pool last).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, sendPending, updateEventSettings, requirePermission, logger } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstractReviewer: { findMany: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  sendPending: vi.fn(),
  updateEventSettings: vi.fn(),
  requirePermission: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({
  auth: () => Promise.resolve({ user: { id: "admin1", role: "ORGANIZER", organizationId: "org1" } }),
}));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/permissions/require-permission", () => ({ requirePermission }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/abstract-reviewer-notify", () => ({ sendPendingAssignments: sendPending }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings }));

import { sendableAssignmentWhere } from "@/lib/abstract-reviewer-access";
import { POST as send } from "@/app/api/events/[eventId]/reviewers/send-assignments/route";
import { DELETE as remove } from "@/app/api/events/[eventId]/reviewers/[reviewerId]/route";

const post = (body: unknown) =>
  send(new Request("http://x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ eventId: "ev1" }) });
const candidateWhere = () => mockDb.abstractReviewer.findMany.mock.calls[0][0].where;
const OK = { ok: true, sent: 3, recorded: true, reclaimed: false };

beforeEach(() => {
  vi.clearAllMocks();
  requirePermission.mockReturnValue({ ok: true, eventWhere: { id: "ev1", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: { reviewerUserIds: ["r1", "r2", "r3"] } });
  mockDb.abstractReviewer.findMany.mockResolvedValue([{ userId: "r1" }, { userId: "r2" }]);
  sendPending.mockResolvedValue(OK);
});
afterEach(() => vi.useRealTimers());

describe("POST send-assignments", () => {
  it("asks the Reviewers page's own key, so every button on that page works for whoever can open it", async () => {
    await post({});
    expect(requirePermission).toHaveBeenCalledWith(expect.anything(), "reviewers.pool.manage", expect.objectContaining({ eventId: "ev1" }));
  });

  it("emails each pool reviewer holding something sendable, once each, in id order", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ emailed: 2, failed: 0, busy: 0, notSetUp: 0, notRecorded: 0, remaining: 0, nextAfter: null });
    expect(sendPending.mock.calls.map(([a]) => a.reviewerUserId)).toEqual(["r1", "r2"]);
    expect(sendPending).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1", triggeredByUserId: "admin1" }));
    expect(candidateWhere()).toEqual({ ...sendableAssignmentWhere("ev1"), userId: { in: ["r1", "r2", "r3"] } });
    expect(mockDb.abstractReviewer.findMany.mock.calls[0][0]).toMatchObject({ distinct: ["userId"], orderBy: { userId: "asc" } });
  });

  it("a named id that is not on the pool is never emailed from this page", async () => {
    mockDb.abstractReviewer.findMany.mockResolvedValue([{ userId: "r1" }]);
    await post({ reviewerIds: ["r1", "removed-last-week"] });
    expect(candidateWhere().userId).toEqual({ in: ["r1"] });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-assignments-send:not-on-pool", ids: ["removed-last-week"] }));
  });

  it("an empty pool sends nothing and reads no assignments", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: {} });
    expect(await (await post({})).json()).toMatchObject({ emailed: 0, remaining: 0, nextAfter: null });
    expect(mockDb.abstractReviewer.findMany).not.toHaveBeenCalled();
    expect(sendPending).not.toHaveBeenCalled();
  });

  it("continues after the cursor the last request answered", async () => {
    await post({ after: "r1" });
    expect(candidateWhere().userId).toEqual({ in: ["r1", "r2", "r3"], gt: "r1" });
  });

  it("stops when its time budget is spent and says where to carry on", async () => {
    vi.useFakeTimers();
    mockDb.abstractReviewer.findMany.mockResolvedValue([{ userId: "r1" }, { userId: "r2" }, { userId: "r3" }]);
    sendPending.mockImplementation(async () => {
      vi.advanceTimersByTime(20_000);
      return OK;
    });
    const body = await (await post({})).json();
    expect(sendPending).toHaveBeenCalledTimes(2);
    expect(body).toMatchObject({ emailed: 2, remaining: 1, nextAfter: "r2" });
  });

  it("always attempts the first reviewer, so a slow send still moves the cursor", async () => {
    vi.useFakeTimers();
    sendPending.mockImplementation(async () => {
      vi.advanceTimersByTime(45_000);
      return OK;
    });
    expect(await (await post({})).json()).toMatchObject({ emailed: 1, remaining: 1, nextAfter: "r1" });
  });

  it("tells skipped apart from failed: busy, not set up and nothing pending are not failures", async () => {
    mockDb.abstractReviewer.findMany.mockResolvedValue([{ userId: "r1" }, { userId: "r2" }, { userId: "r3" }, { userId: "r4" }, { userId: "r5" }]);
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: { reviewerUserIds: ["r1", "r2", "r3", "r4", "r5"] } });
    sendPending
      .mockResolvedValueOnce({ ok: false, code: "SEND_FAILED", message: "refused" })
      .mockResolvedValueOnce({ ok: false, code: "NOTHING_PENDING", message: "nothing" })
      .mockResolvedValueOnce({ ok: false, code: "IN_PROGRESS", message: "busy" })
      .mockResolvedValueOnce({ ok: false, code: "ACCOUNT_NOT_SET_UP", message: "invite first" })
      .mockResolvedValueOnce({ ok: true, sent: 2, recorded: false, reclaimed: true });
    const body = await (await post({})).json();
    expect(body).toMatchObject({ emailed: 1, failed: 1, busy: 1, notSetUp: 1, notRecorded: 1 });
    expect(body.results[4]).toMatchObject({ reviewerId: "r5", ok: true, recorded: false, reclaimed: true });
  });

  it("refuses a body that is not JSON, never reading it as 'send to everyone'", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ reviewerIds: "r1" })).status).toBe(400);
    expect((await post({ everyone: true })).status).toBe(400);
    expect(sendPending).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-assignments-send:invalid-input" }));
  });

  it("an event out of reach is a logged 404", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await post({})).status).toBe(404);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-assignments-send:event-not-found" }));
    expect(sendPending).not.toHaveBeenCalled();
  });
});

describe("DELETE a reviewer", () => {
  const del = () => remove(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ eventId: "ev1", reviewerId: "r1" }) });

  it("takes them off every abstract assigned on this event, then off the pool", async () => {
    mockDb.abstractReviewer.deleteMany.mockResolvedValue({ count: 4 });
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, assignmentsRemoved: 4 });
    expect(mockDb.abstractReviewer.deleteMany).toHaveBeenCalledWith({ where: { userId: "r1", abstract: { eventId: "ev1" } } });
    expect(updateEventSettings).toHaveBeenCalledTimes(1);
    // The review right goes first: every failure can then be retried.
    expect(mockDb.abstractReviewer.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(updateEventSettings.mock.invocationCallOrder[0]);
  });

  it("a failed delete changes nothing, so the organiser can press Remove again", async () => {
    mockDb.abstractReviewer.deleteMany.mockRejectedValue(new Error("db down"));
    expect((await del()).status).toBe(500);
    expect(updateEventSettings).not.toHaveBeenCalled();
  });

  it("someone not on the pool is a logged 404", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: { reviewerUserIds: [] } });
    expect((await del()).status).toBe(404);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "events/reviewers:remove-not-on-pool" }));
    expect(mockDb.abstractReviewer.deleteMany).not.toHaveBeenCalled();
  });
});
