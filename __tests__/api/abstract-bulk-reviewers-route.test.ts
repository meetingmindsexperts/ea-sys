/**
 * POST / DELETE /api/events/[eventId]/abstracts/reviewer-assignments: the
 * route's own duties (review of 87d819ee, Nov 12, 2026). The status matrix
 * mocks the rate limit open and only reads a status, so these mutations
 * survived it: dropping the rate limit, POST and DELETE calling each other's
 * service function, a wrong code-to-status map, an unlogged 400.
 *
 * The rules themselves are pinned in abstract-service-bulk-reviewers.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockRateLimit, mockAssign, mockUnassign, mockLogger } = vi.hoisted(() => ({
  mockDb: { event: { findFirst: vi.fn() } },
  mockAuth: vi.fn(),
  mockRateLimit: vi.fn(),
  mockAssign: vi.fn(),
  mockUnassign: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/security", () => ({ checkRateLimit: mockRateLimit, getClientIp: () => "1.2.3.4" }));
vi.mock("@/services/abstract-service", () => ({
  assignReviewersBulk: mockAssign,
  unassignReviewersBulk: mockUnassign,
  MAX_BULK_REVIEWER_PAIRS: 5000,
}));

import { POST, DELETE } from "@/app/api/events/[eventId]/abstracts/reviewer-assignments/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const GROUPS = [{ reviewerUserId: "rev1", abstractIds: ["ab1", "ab2"] }];
const req = (method: "POST" | "DELETE", body: unknown = { groups: GROUPS }) =>
  new Request("http://x/api/events/ev1/abstracts/reviewer-assignments", {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockRateLimit.mockReturnValue({ allowed: true, remaining: 59, retryAfterSeconds: 0 });
  mockAssign.mockResolvedValue({ ok: true, assigned: 2, alreadyAssigned: 0, skipped: [] });
  mockUnassign.mockResolvedValue({ ok: true, removed: 2, notAssigned: 0, skipped: [] });
});

describe("each verb does its own work", () => {
  it("POST assigns, with the caller as the actor and the caller's organisation", async () => {
    const res = await POST(req("POST"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, assigned: 2, alreadyAssigned: 0, skipped: [] });
    expect(mockAssign).toHaveBeenCalledWith({
      eventId: "ev1",
      organizationId: "org1",
      groups: GROUPS,
      actorUserId: "admin1",
      source: "rest",
      ip: "1.2.3.4",
    });
    expect(mockUnassign).not.toHaveBeenCalled();
  });

  it("DELETE removes, and never assigns", async () => {
    const res = await DELETE(req("DELETE"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, removed: 2, notAssigned: 0, skipped: [] });
    expect(mockUnassign).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1", organizationId: "org1", groups: GROUPS, actorUserId: "admin1" }));
    expect(mockAssign).not.toHaveBeenCalled();
  });
});

describe.each([
  ["POST", POST, mockAssign],
  ["DELETE", DELETE, mockUnassign],
] as const)("%s: what is refused before any work", (method, handler, service) => {
  it("401 without a session", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await handler(req(method), params)).status).toBe(401);
    expect(service).not.toHaveBeenCalled();
  });

  it("403 for a role without the key, 404 for an event the grant does not reach (logged)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", organizationId: "org1" } });
    expect((await handler(req(method), params)).status).toBe(403);

    mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", organizationId: "org1" } });
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await handler(req(method), params)).status).toBe(404);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "abstracts/reviewer-assignments:event-not-found" }));
    expect(service).not.toHaveBeenCalled();
  });

  it("429 with Retry-After and the limit, keyed per person, logged", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 120 });
    const res = await handler(req(method), params);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(await res.json()).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 120, limit: 60, windowSeconds: 3600 });
    expect(mockRateLimit).toHaveBeenCalledWith({ key: "abstract-bulk-reviewers:admin1", limit: 60, windowMs: 3_600_000 });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "abstracts/reviewer-assignments:rate-limited" }));
    expect(service).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{nope"],
    ["no groups", {}],
    ["an empty group list", { groups: [] }],
    ["a group with no abstracts", { groups: [{ reviewerUserId: "rev1", abstractIds: [] }] }],
    ["a group with no reviewer", { groups: [{ abstractIds: ["ab1"] }] }],
  ])("400 for %s, with the field errors logged", async (_label, body) => {
    const res = await handler(req(method, body), params);
    expect(res.status).toBe(400);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "abstracts/reviewer-assignments:zod-validation-failed", verb: method }));
    expect(service).not.toHaveBeenCalled();
  });

  it.each([
    ["EVENT_NOT_FOUND", 404],
    ["NO_PAIRS", 400],
    ["TOO_MANY", 400],
    ["UNKNOWN", 500],
  ])("a service refusal %s answers %i with its code and message", async (code, status) => {
    service.mockResolvedValue({ ok: false, code, message: "why" });
    const res = await handler(req(method), params);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: "why", code });
  });

  it("an unexpected throw is a logged 500 with a static message", async () => {
    service.mockRejectedValue(new Error("secret detail"));
    const res = await handler(req(method), params);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret detail");
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
