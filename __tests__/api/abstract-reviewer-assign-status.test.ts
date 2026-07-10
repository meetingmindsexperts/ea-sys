/**
 * Reviewer-assignment status gate (abstracts review H6, July 10 2026).
 * A reviewer may only be assigned to an abstract that is actually up for
 * review — not a DRAFT (author's WIP), a WITHDRAWN, or an already-decided
 * abstract. Parity with the scoring gate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, notifySpy } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    abstractReviewer: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockAuth: vi.fn(),
  notifySpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/abstract-reviewer-notify", () => ({ notifyReviewerAssigned: notifySpy }));

import { POST } from "@/app/api/events/[eventId]/abstracts/[abstractId]/reviewers/route";

const params = { params: Promise.resolve({ eventId: "ev1", abstractId: "ab1" }) };
const admin = { user: { id: "admin1", role: "ADMIN", organizationId: "org1" } };
function req(body: Record<string, unknown>) {
  return new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(admin);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "Ev" });
  mockDb.user.findUnique.mockResolvedValue({ id: "rev1", firstName: "R", lastName: "One", email: "r@x.com" });
  mockDb.abstractReviewer.findUnique.mockResolvedValue(null);
  mockDb.abstractReviewer.create.mockResolvedValue({ id: "ar1", role: "PRIMARY", conflictFlag: false });
});

describe("assign reviewer — H6 status gate", () => {
  it.each(["DRAFT", "WITHDRAWN", "ACCEPTED", "REJECTED"])(
    "refuses assignment onto a %s abstract (409 NOT_REVIEWABLE, no create, no email)",
    async (status) => {
      mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", title: "T", status });
      const res = await POST(req({ userId: "rev1" }), params);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("NOT_REVIEWABLE");
      expect(mockDb.abstractReviewer.create).not.toHaveBeenCalled();
      expect(notifySpy).not.toHaveBeenCalled();
    },
  );

  it.each(["SUBMITTED", "UNDER_REVIEW", "REVISION_REQUESTED"])(
    "allows assignment onto a %s abstract",
    async (status) => {
      mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", title: "T", status });
      const res = await POST(req({ userId: "rev1" }), params);
      expect(res.status).toBeLessThan(400);
      expect(mockDb.abstractReviewer.create).toHaveBeenCalledTimes(1);
    },
  );
});
