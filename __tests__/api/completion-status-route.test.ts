/**
 * GET .../registrations/completion-status: the desk's waiting-list poll
 * (review of cf9775fd, MED 5). One small read for everyone waiting.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() }, registration: { findMany: vi.fn() } },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { GET } from "@/app/api/events/[eventId]/registrations/completion-status/route";

const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const get = (ids: string) => GET(new Request(`http://x/completion-status?ids=${ids}`), params);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
});

describe("GET completion-status", () => {
  it("answers completed for completedAt or an account, only for this event's rows, selecting nothing else", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      { id: "a", status: "CONFIRMED", completedAt: new Date(), userId: null },
      { id: "b", status: "CONFIRMED", completedAt: null, userId: "u-1" },
      { id: "c", status: "CANCELLED", completedAt: null, userId: null },
    ]);
    const res = await get("a,b,c,elsewhere");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      statuses: [
        { id: "a", status: "CONFIRMED", completed: true },
        { id: "b", status: "CONFIRMED", completed: true },
        { id: "c", status: "CANCELLED", completed: false },
      ],
    });
    const query = mockDb.registration.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ id: { in: ["a", "b", "c", "elsewhere"] }, eventId: "evt-1" });
    expect(Object.keys(query.select).sort()).toEqual(["completedAt", "id", "status", "userId"]);
  });

  it("refuses no ids or too many, and an event outside the grant", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get(Array.from({ length: 51 }, (_, i) => `r${i}`).join(","))).status).toBe(400);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await get("a")).status).toBe(404);
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
  });
});
