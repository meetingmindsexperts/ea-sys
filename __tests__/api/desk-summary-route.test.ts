/**
 * GET /api/events/[eventId]/registrations/desk-summary: the desk's day summary
 * (docs/ONSITE_DESK_PLAN.md §9). These pin what the route asks the database
 * for, because the scope is in the where clauses: a manager (payments.refund
 * on the event) reads every desk user, anyone else only their own payments and
 * the walk-ins they registered, and the money is bound to this event
 * (review of 9c1ecc06, MED 2).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn(), count: vi.fn() },
    registration: { findMany: vi.fn() },
    payment: { findMany: vi.fn() },
    auditLog: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { GET } from "@/app/api/events/[eventId]/registrations/desk-summary/route";

const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const as = (role: string) => ({ user: { id: "user-1", role, organizationId: "org-1" } });
const get = (query = "date=2026-11-02") =>
  GET(new Request(`http://x/api/events/evt-1/registrations/desk-summary?${query}`), params);

const WALK_INS = [
  // Registered by this user: Standard stamped at 0, the tier repriced to 100 since.
  { id: "w1", status: "CHECKED_IN", paymentStatus: "COMPLIMENTARY", originalPrice: 0, ticketType: { name: "Physician", price: 0 }, pricingTier: { name: "Standard", price: 100 } },
  // Registered by someone else.
  { id: "w2", status: "CHECKED_IN", paymentStatus: "PAID", originalPrice: 100, ticketType: { name: "Physician", price: 0 }, pricingTier: { name: "Standard", price: 100 } },
  // Cancelled since: counted nowhere.
  { id: "w3", status: "CANCELLED", paymentStatus: "COMPLIMENTARY", originalPrice: 0, ticketType: { name: "Physician", price: 0 }, pricingTier: { name: "Standard", price: 0 } },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", timezone: "Asia/Dubai" });
  // The manager test: an event filter that can match (the key held) or one that matches nothing.
  mockDb.event.count.mockImplementation(async ({ where }: { where: { id?: { in?: unknown[] } } }) =>
    Array.isArray(where.id?.in) && where.id.in.length === 0 ? 0 : 1,
  );
  mockDb.registration.findMany.mockResolvedValue(WALK_INS);
  mockDb.payment.findMany.mockResolvedValue([]);
  mockDb.auditLog.findMany.mockResolvedValue([
    { entityId: "w1", userId: "user-1" },
    { entityId: "w2", userId: "user-2" },
    { entityId: "w3", userId: "user-1" },
  ]);
  mockDb.user.findMany.mockResolvedValue([]);
});

describe("GET desk-summary", () => {
  it("a manager reads every desk user's money, bound to this event and to desk methods", async () => {
    mockAuth.mockResolvedValue(as("ADMIN"));
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("all");

    const where = mockDb.payment.findMany.mock.calls[0][0].where;
    expect(where.registration).toEqual({ eventId: "evt-1" });
    expect(where.paymentMethodType).toEqual({ in: ["cash", "card_onsite"] });
    expect(where.metadata).toBeUndefined();
    expect(body.walkIns.total).toBe(2);
    expect(body.walkIns.cancelled).toBe(1);
  });

  it("a desk user without payments.refund reads only their own payments and walk-ins", async () => {
    mockAuth.mockResolvedValue(as("MEMBER"));
    const body = await (await get()).json();
    expect(body.scope).toBe("own");

    const where = mockDb.payment.findMany.mock.calls[0][0].where;
    expect(where.metadata).toEqual({ path: ["recordedByUserId"], equals: "user-1" });
    expect(where.registration).toEqual({ eventId: "evt-1" });
    // w2 is another user's; w3 is theirs but cancelled.
    expect(body.walkIns.total).toBe(1);
    expect(body.walkIns.cancelled).toBe(1);
    expect(body.walkIns.totals.paid).toBe(0);
  });

  it("the stamped price decides Free, not the tier's price today", async () => {
    mockAuth.mockResolvedValue(as("ADMIN"));
    const body = await (await get()).json();
    expect(body.walkIns.totals.free).toBe(1);
    expect(body.walkIns.totals.comp).toBe(0);
  });

  it("walk-ins are this event's desk walk-ins in the day's bounds", async () => {
    mockAuth.mockResolvedValue(as("ADMIN"));
    await get();
    const where = mockDb.registration.findMany.mock.calls[0][0].where;
    expect(where.eventId).toBe("evt-1");
    expect(where.createdSource).toBe("ONSITE_DESK");
    expect(where.createdAt.gte.toISOString()).toBe("2026-11-01T20:00:00.000Z");
    expect(where.createdAt.lt.toISOString()).toBe("2026-11-02T20:00:00.000Z");
  });

  it("an unknown stored timezone falls back instead of failing", async () => {
    mockAuth.mockResolvedValue(as("ADMIN"));
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", timezone: "GST" });
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).timezone).toBe("Asia/Dubai");
  });

  it("refuses a malformed date, and a role without payments.record", async () => {
    mockAuth.mockResolvedValue(as("ADMIN"));
    expect((await get("date=2026-02-31")).status).toBe(400);
    mockAuth.mockResolvedValue(as("CRM_USER"));
    expect((await get()).status).toBe(403);
    expect(mockDb.payment.findMany).not.toHaveBeenCalled();
  });
});
