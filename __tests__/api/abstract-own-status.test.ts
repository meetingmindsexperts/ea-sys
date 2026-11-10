/**
 * A reviewer does not decide their own abstract (Nov 9, 2026). Reviewing on one
 * event and submitting to another is normal, so one account can reach an
 * abstract it wrote through a pool it sits on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET, PUT } from "@/app/api/events/[eventId]/abstracts/[abstractId]/route";

const params = { params: Promise.resolve({ eventId: "ev1", abstractId: "ab1" }) };
const put = (body: unknown) =>
  PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), params);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "rev1", email: "rev@example.com", role: "REVIEWER", organizationId: null } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", name: "Conf", settings: { reviewerUserIds: ["rev1"] } });
});

describe("a REVIEWER setting the status of an abstract", () => {
  it.each([
    ["their linked speaker row", { userId: "rev1", email: "other@example.com" }],
    ["an unlinked row at their address", { userId: null, email: "REV@example.com" }],
  ])("is refused on %s, and nothing is written", async (_label, speaker) => {
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", status: "SUBMITTED", speaker });
    const res = await put({ status: "ACCEPTED" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("OWN_ABSTRACT");
    expect(mockDb.abstract.updateMany).not.toHaveBeenCalled();
    expect(mockDb.abstract.update).not.toHaveBeenCalled();
  });

  it("is not refused for this reason on someone else's", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", status: "SUBMITTED", speaker: { userId: "u9", email: "author@example.com" } });
    const res = await put({ status: "UNDER_REVIEW" });
    expect((await res.json()).code).not.toBe("OWN_ABSTRACT");
  });
});

describe("a REVIEWER reaches only abstracts assigned to them (Nov 10, 2026)", () => {
  it("the status change looks the abstract up through their assignment: the pool alone finds nothing", async () => {
    mockDb.abstract.findFirst.mockResolvedValue(null);
    const res = await put({ status: "ACCEPTED" });
    expect(res.status).toBe(404);
    expect(mockDb.abstract.findFirst.mock.calls[0][0].where).toMatchObject({ reviewers: { some: { userId: "rev1" } } });
    expect(mockDb.abstract.update).not.toHaveBeenCalled();
  });

  it("so does reading it", async () => {
    mockDb.abstract.findFirst.mockResolvedValue(null);
    const res = await GET(new Request("http://x"), params);
    expect(res.status).toBe(404);
    expect(mockDb.abstract.findFirst.mock.calls[0][0].where).toMatchObject({ reviewers: { some: { userId: "rev1" } } });
  });
});
