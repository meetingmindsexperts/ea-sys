/**
 * DELETE /api/events/[eventId]/abstracts/[abstractId] (Nov 17, 2026).
 *
 * Admins were given abstract delete that day (it had been the super admin's
 * alone), and the review of that change found the safety net thinner than it
 * was described: the audit row is the only copy of what a delete destroys, and
 * it held the abstract's own row but not the reviewer assignments and submitted
 * reviews that are deleted with it. Pinned here: who may delete, that the copy
 * holds the reviews, and that nothing is deleted unless the copy is written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, tx } = vi.hoisted(() => {
  const tx = { abstract: { delete: vi.fn() }, auditLog: { create: vi.fn() } };
  return {
    tx,
    mockDb: {
      event: { findFirst: vi.fn() },
      abstract: { findFirst: vi.fn(), delete: vi.fn() },
      auditLog: { create: vi.fn() },
    },
    mockAuth: vi.fn(),
  };
});

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  // The real one opens a database transaction; here it runs the callback, and
  // a throw inside it propagates as a rolled-back transaction would.
  tenantTransaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { DELETE } from "@/app/api/events/[eventId]/abstracts/[abstractId]/route";

const params = { params: Promise.resolve({ eventId: "ev1", abstractId: "ab1" }) };
const del = () => DELETE(new Request("http://x", { method: "DELETE" }), params);
const signedInAs = (role: string, organizationId: string | null = "org1") =>
  mockAuth.mockResolvedValue({ user: { id: "u1", email: "u@example.com", role, organizationId } });

const ABSTRACT = {
  id: "ab1",
  eventId: "ev1",
  title: "Outcomes of SGLT2 inhibitors",
  status: "ACCEPTED",
  eventSession: null,
  reviewers: [{ id: "ar1", userId: "rev1", role: "PRIMARY" }],
  submissions: [
    { id: "s1", reviewerUserId: "rev1", overallScore: 82, reviewNotes: "Strong methods." },
    { id: "s2", reviewerUserId: "rev2", overallScore: 64, reviewNotes: "Small sample." },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  mockDb.abstract.findFirst.mockResolvedValue(ABSTRACT);
  tx.abstract.delete.mockResolvedValue({});
  tx.auditLog.create.mockResolvedValue({});
});

describe("who may delete an abstract", () => {
  it.each(["SUPER_ADMIN", "ADMIN"])("%s may", async (role) => {
    signedInAs(role);
    const res = await del();
    expect(res.status).toBe(200);
    expect(tx.abstract.delete).toHaveBeenCalledWith({ where: { id: "ab1" } });
  });

  it.each(["ORGANIZER", "MEMBER", "ONSITE", "CRM_USER", "HR_USER", "BASE"])("%s may not, and nothing is read or deleted", async (role) => {
    signedInAs(role);
    const res = await del();
    expect(res.status).toBe(403);
    expect(mockDb.abstract.findFirst).not.toHaveBeenCalled();
    expect(tx.abstract.delete).not.toHaveBeenCalled();
  });

  it.each(["REVIEWER", "SUBMITTER", "REGISTRANT"])("%s (an author or a reviewer) may not", async (role) => {
    signedInAs(role, null);
    const res = await del();
    expect(res.status).toBe(403);
    expect(tx.abstract.delete).not.toHaveBeenCalled();
  });

  it("nobody signed in is refused", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await del()).status).toBe(401);
  });
});

describe("what a delete leaves behind", () => {
  beforeEach(() => signedInAs("ADMIN"));

  it("reads the reviewer assignments and the submitted reviews, which are deleted with the abstract", async () => {
    await del();
    expect(mockDb.abstract.findFirst.mock.calls[0][0].include).toMatchObject({ reviewers: true, submissions: true });
  });

  it("writes a copy of the abstract WITH its reviews to the audit log", async () => {
    await del();
    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ eventId: "ev1", userId: "u1", action: "DELETE", entityType: "Abstract", entityId: "ab1" });
    expect(audit.changes.deleted.title).toBe("Outcomes of SGLT2 inhibitors");
    expect(audit.changes.deleted.reviewers).toHaveLength(1);
    expect(audit.changes.deleted.submissions.map((s: { reviewNotes: string }) => s.reviewNotes)).toEqual([
      "Strong methods.",
      "Small sample.",
    ]);
  });

  it("deletes and writes the copy in one transaction, never outside it", async () => {
    await del();
    expect(tx.abstract.delete).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockDb.abstract.delete).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("answers 500 when the copy cannot be written, so the caller is not told it was deleted", async () => {
    tx.auditLog.create.mockRejectedValue(new Error("audit insert failed"));
    expect((await del()).status).toBe(500);
  });
});

describe("what is refused whoever asks", () => {
  beforeEach(() => signedInAs("ADMIN"));

  it("an abstract linked to a session", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ ...ABSTRACT, eventSession: { id: "ses1", name: "Plenary" } });
    const res = await del();
    expect(res.status).toBe(400);
    expect(tx.abstract.delete).not.toHaveBeenCalled();
  });

  it("an abstract that is not on this event", async () => {
    mockDb.abstract.findFirst.mockResolvedValue(null);
    const res = await del();
    expect(res.status).toBe(404);
    expect(mockDb.abstract.findFirst.mock.calls[0][0].where).toEqual({ id: "ab1", eventId: "ev1" });
    expect(tx.abstract.delete).not.toHaveBeenCalled();
  });

  it("an event outside the caller's organisation", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await del();
    expect(res.status).toBe(404);
    expect(mockDb.abstract.findFirst).not.toHaveBeenCalled();
  });
});
