/**
 * Send to all (Nov 10, 2026): the one reviewer invitation to everyone on the
 * event's pool, through the same sender as the row's Send button.
 *
 * The route sends for 30 seconds per request and answers where to carry on
 * (nginx cuts a response at 60); the page chains the requests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, mockAuth, sendSpy, rateLimit, logger } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    user: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockAuth: vi.fn(),
  sendSpy: vi.fn(),
  rateLimit: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: () => ({ ok: true, eventWhere: { id: "ev1", organizationId: "org1" } }),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: rateLimit }));
vi.mock("@/lib/public-brand-server", () => ({ loadPublicBrandForOrg: async () => ({ name: "Meeting Minds Experts" }) }));
vi.mock("@/lib/abstract-reviewer-notify", async () => {
  const actual = await vi.importActual<typeof import("@/lib/abstract-reviewer-notify")>("@/lib/abstract-reviewer-notify");
  return { sendReviewerInvitation: sendSpy, inviterNameOf: actual.inviterNameOf };
});

import { POST } from "@/app/api/events/[eventId]/reviewers/send-invitations/route";

const USERS = ["r1", "r2", "r3"].map((id) => ({ id, email: `${id}@x.com`, firstName: id, lastName: "R", emailVerified: null, role: "REVIEWER" }));
const post = (body: unknown = {}) =>
  POST(new Request("http://x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ eventId: "ev1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ORGANIZER", organizationId: "org1", firstName: "Sarah", lastName: "Ahmed" } });
  rateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  // r9 was removed from the pool: on the event's list or not at all.
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "MedCon", slug: "medcon", settings: { reviewerUserIds: ["r3", "r1", "r2"] } });
  mockDb.user.findMany.mockImplementation(({ where }: { where: { id: { in: string[]; gt?: string } } }) =>
    Promise.resolve(USERS.filter((u) => where.id.in.includes(u.id) && (!where.id.gt || u.id > where.id.gt))),
  );
  sendSpy.mockResolvedValue({ ok: true, kind: "setup" });
});
afterEach(() => vi.useRealTimers());

describe("POST reviewers/send-invitations", () => {
  it("emails everyone on the pool, in id order, through the one sender", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ emailed: 3, failed: 0, remaining: 0, nextAfter: null });
    expect(mockDb.user.findMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: ["r3", "r1", "r2"] } }, orderBy: { id: "asc" } });
    expect(sendSpy.mock.calls.map(([a]) => a.reviewer.id)).toEqual(["r1", "r2", "r3"]);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      eventId: "ev1", organizationId: "org1", eventName: "MedCon", eventSlug: "medcon",
      organizationName: "Meeting Minds Experts", inviterName: "Sarah Ahmed", triggeredByUserId: "admin1",
    });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes.sendInvitations).toMatchObject({ emailed: 3, failed: 0, remaining: 0 });
  });

  it("carries on after the cursor", async () => {
    await post({ after: "r1" });
    expect(sendSpy.mock.calls.map(([a]) => a.reviewer.id)).toEqual(["r2", "r3"]);
  });

  it("one failure does not stop the rest, and its reason is answered and logged", async () => {
    sendSpy.mockResolvedValueOnce({ ok: false, code: "SEND_FAILED", message: "The template has an unknown token" });
    const body = await (await post()).json();
    expect(body).toMatchObject({ emailed: 2, failed: 1 });
    expect(body.results[0]).toEqual({ reviewerId: "r1", ok: false, message: "The template has an unknown token" });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-invitations-send:some-failed" }));
  });

  it("stops after its 30 seconds and says where to carry on", async () => {
    vi.useFakeTimers();
    sendSpy.mockImplementation(async () => {
      vi.advanceTimersByTime(31_000);
      return { ok: true, kind: "portal" };
    });
    const body = await (await post()).json();
    // The first is always attempted, so the cursor moves on every request.
    expect(body).toMatchObject({ emailed: 1, remaining: 2, nextAfter: "r1" });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("an empty pool sends nothing", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "MedCon", slug: "medcon", settings: {} });
    expect(await (await post()).json()).toMatchObject({ emailed: 0, failed: 0, remaining: 0, nextAfter: null });
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON, or names reviewers: it is never read as 'send to everyone'", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ reviewerIds: ["r1"] })).status).toBe(400);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-invitations-send:invalid-input" }));
  });

  it("401 signed out, 404 for an event the caller cannot reach, 429 over the limit: each logged, nothing sent", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await post()).status).toBe(401);

    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await post()).status).toBe(404);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-invitations-send:event-not-found" }));

    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 120 });
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("120");
    expect(await limited.json()).toMatchObject({ retryAfterSeconds: 120, limit: 60, windowSeconds: 3600 });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
