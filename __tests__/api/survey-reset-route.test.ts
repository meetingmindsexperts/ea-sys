/**
 * DELETE /api/events/[eventId]/registrations/[registrationId]/survey
 * (Sep 17, 2026): an admin or organizer resets one person's submitted survey.
 *
 * Owner decisions pinned here: admins and organizers only; the certificate
 * trigger and auto-issue bookkeeping are cleared so a new answer is checked
 * again; certificates are kept; the answers are not copied into the audit row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => {
  const mockDb = {
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    surveyResponse: { deleteMany: vi.fn() },
    attendee: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return { mockDb, mockAuth: vi.fn() };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: typeof mockDb) => unknown) => fn(mockDb),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));

import { DELETE } from "@/app/api/events/[eventId]/registrations/[registrationId]/survey/route";

const params = Promise.resolve({ eventId: "ev1", registrationId: "reg1" });
const reset = () => DELETE(new Request("http://localhost/x", { method: "DELETE" }), { params });

function completed(extra: Record<string, unknown> = {}) {
  return {
    id: "reg1",
    attendeeId: "att1",
    surveyCompletedAt: new Date("2026-09-17T13:38:20Z"),
    surveyResponse: { id: "resp1", answers: { q1: 5, q2: "My phone is 050 123 4567", q3: "Yes" } },
    issuedCertificates: [{ serial: "OOPVF2026-ATT-0001" }],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  mockDb.registration.findFirst.mockResolvedValue(completed());
  mockDb.registration.count.mockResolvedValue(0);
  mockDb.surveyResponse.deleteMany.mockResolvedValue({ count: 1 });
  mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
  mockDb.attendee.findUnique.mockResolvedValue({ tags: ["Cme", "survey-completed"] });
  mockDb.attendee.update.mockResolvedValue({});
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("survey reset", () => {
  it("deletes the answers and clears the certificate trigger and auto-issue state", async () => {
    const res = await reset();

    expect(res.status).toBe(200);
    expect(mockDb.surveyResponse.deleteMany).toHaveBeenCalledWith({ where: { registrationId: "reg1" } });
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg1", eventId: "ev1" },
      data: {
        surveyCompletedAt: null,
        certAutoIssueCheckedAt: null,
        certAutoIssueAttempts: 0,
        certAutoIssueNextAttemptAt: null,
        certAutoIssueError: null,
      },
    });
    expect(mockDb.attendee.update).toHaveBeenCalledWith({ where: { id: "att1" }, data: { tags: ["Cme"] } });
    expect(await res.json()).toEqual({ success: true, keptCertificates: ["OOPVF2026-ATT-0001"] });
  });

  it("records who, when and how many answers, but never the answers", async () => {
    await reset();

    const data = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ action: "SURVEY_RESET", entityType: "Registration", entityId: "reg1", userId: "u1" });
    expect(data.changes).toMatchObject({ answerCount: 3, tagRemoved: true, keptCertificates: ["OOPVF2026-ATT-0001"] });
    expect(JSON.stringify(data.changes)).not.toContain("050 123 4567");
  });

  it("removes the tag in the capitalization a registration edit leaves (Survey-completed)", async () => {
    mockDb.attendee.findUnique.mockResolvedValue({ tags: ["Cme", "Survey-completed", "Speaker"] });

    await reset();

    expect(mockDb.attendee.update).toHaveBeenCalledWith({ where: { id: "att1" }, data: { tags: ["Cme", "Speaker"] } });
  });

  it("keeps the tag when another registration of the same attendee still has a completed survey", async () => {
    mockDb.registration.count.mockResolvedValue(1);

    await reset();

    expect(mockDb.attendee.update).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes.tagRemoved).toBe(false);
  });

  it.each(["MEMBER", "ONSITE", "WEBINARS", "REVIEWER", "REGISTRANT"])("refuses %s", async (role) => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role, organizationId: "org1" } });

    const res = await reset();

    expect(res.status).toBe(403);
    expect(mockDb.surveyResponse.deleteMany).not.toHaveBeenCalled();
  });

  it("allows an admin", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u3", role: "ADMIN", organizationId: "org1" } });
    expect((await reset()).status).toBe(200);
  });

  it("says there is nothing to reset when the person has not answered", async () => {
    mockDb.registration.findFirst.mockResolvedValue(completed({ surveyCompletedAt: null, surveyResponse: null }));

    const res = await reset();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOTHING_TO_RESET");
    expect(mockDb.surveyResponse.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 for a registration outside this event", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    expect((await reset()).status).toBe(404);
  });

  it("returns 401 without a session", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await reset()).status).toBe(401);
  });
});
