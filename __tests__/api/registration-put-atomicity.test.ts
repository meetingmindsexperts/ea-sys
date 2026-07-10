/**
 * Registration PUT atomicity (review H7) — attendee edits + the sync side
 * effects must commit WITH the registration row, not before it. The old code
 * wrote the Attendee + Contact sync + speaker-tag mirror BEFORE the
 * transaction holding the optimistic lock, so a STALE_WRITE 409 ("reload and
 * try again") had already persisted half the edit — silently interleaving two
 * editors' data. These pin:
 *   - stale write → 409, attendee patch NEVER written, no contact sync
 *   - happy path → attendee patch written INSIDE the tx, contact sync after
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockSyncToContact, txOrder } = vi.hoisted(() => {
  const txOrder: string[] = [];
  const tx = {
    registration: {
      updateMany: vi.fn(async () => {
        txOrder.push("registration.updateMany");
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(),
    },
    ticketType: { findUnique: vi.fn().mockResolvedValue({ name: "Nurse" }) },
    attendee: {
      update: vi.fn(async () => {
        txOrder.push("attendee.update");
        return {};
      }),
    },
    pricingTier: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    promoCode: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  return {
    txOrder,
    mockDb: {
      event: { findFirst: vi.fn() },
      registration: { findFirst: vi.fn() },
      ticketType: { findFirst: vi.fn() },
      pricingTier: { findFirst: vi.fn() },
      billingAccount: { findFirst: vi.fn() },
      speaker: { findMany: vi.fn().mockResolvedValue([]) },
      attendee: { update: vi.fn() }, // must stay UNUSED — the patch goes through tx
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      invoice: { aggregate: vi.fn().mockResolvedValue({ _sum: { total: null } }) },
      $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      _tx: tx,
    },
    mockAuth: vi.fn(),
    mockSyncToContact: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/utils", () => ({ normalizeTag: (t: string) => t, generateBarcode: () => "BC" }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: mockSyncToContact }));
vi.mock("@/lib/storage", () => ({ deletePhoto: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/webinar", () => ({ readSponsors: () => [] }));
// person-tag-sync + seat model + guards stay REAL (pure or db-mocked).

import { PUT } from "@/app/api/events/[eventId]/registrations/[registrationId]/route";

const NOW = "2026-07-10T10:00:00.000Z";
const params = Promise.resolve({ eventId: "ev1", registrationId: "reg1" });

function req(body: Record<string, unknown>) {
  return new Request("http://localhost/x", {
    method: "PUT",
    body: JSON.stringify({ expectedUpdatedAt: NOW, ...body }),
    headers: { "content-type": "application/json" },
  });
}

function existingReg() {
  return {
    id: "reg1", eventId: "ev1", attendeeId: "att1",
    ticketTypeId: "tt1", pricingTierId: null,
    paymentStatus: "UNPAID", status: "CONFIRMED", attendanceMode: "IN_PERSON",
    createdSource: "ADMIN_DASHBOARD", qrCode: "QR",
    promoCodeId: null, discountAmount: null, originalPrice: 100, sponsorId: null,
    updatedAt: new Date(NOW),
    attendee: {
      id: "att1", firstName: "A", lastName: "B", email: "a@b.com", country: "AE",
      tags: [], additionalEmail: null, title: null, role: null, organization: null,
      jobTitle: null, phone: null, photo: null, city: null, bio: null,
      specialty: null, registrationType: null, associationName: null,
      memberId: null, studentId: null, studentIdExpiry: null,
    },
  };
}

function returnedReg() {
  return {
    id: "reg1", eventId: "ev1", status: "CONFIRMED", paymentStatus: "UNPAID",
    attendanceMode: "IN_PERSON", originalPrice: 100, discountAmount: null,
    ticketType: { id: "tt1", name: "Standard", price: 100, currency: "USD" },
    pricingTier: null,
    attendee: { id: "att1", firstName: "New", lastName: "B", email: "a@b.com" },
    payments: [], accommodation: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  txOrder.length = 0;
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: {}, taxRate: null, taxLabel: null });
  mockDb.registration.findFirst.mockResolvedValue(existingReg());
  mockDb._tx.registration.updateMany.mockImplementation(async () => {
    txOrder.push("registration.updateMany");
    return { count: 1 };
  });
  mockDb._tx.registration.findUniqueOrThrow.mockResolvedValue(returnedReg());
});

describe("registration PUT atomicity (H7)", () => {
  it("STALE_WRITE → 409 and the attendee patch is NEVER persisted (no writes, no contact sync)", async () => {
    mockDb._tx.registration.updateMany.mockResolvedValue({ count: 0 }); // lock lost
    const res = await PUT(
      req({ attendee: { firstName: "Interloper", tags: ["Vip"] }, status: "CONFIRMED" }),
      { params },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("STALE_WRITE");
    // The whole point of the fix: nothing about the attendee was written.
    expect(mockDb._tx.attendee.update).not.toHaveBeenCalled();
    expect(mockDb.attendee.update).not.toHaveBeenCalled();
    expect(mockSyncToContact).not.toHaveBeenCalled();
  });

  it("happy path: attendee patch commits INSIDE the tx AFTER the lock check; contact sync runs after", async () => {
    const res = await PUT(req({ attendee: { firstName: "New" } }), { params });
    expect(res.status).toBe(200);
    // Inside the tx, ordered after the lock-holding updateMany.
    expect(txOrder).toEqual(["registration.updateMany", "attendee.update"]);
    expect(mockDb._tx.attendee.update).toHaveBeenCalledWith({
      where: { id: "att1" },
      data: expect.objectContaining({ firstName: "New" }),
    });
    // Pre-tx direct write is gone.
    expect(mockDb.attendee.update).not.toHaveBeenCalled();
    // Contact sync fires post-commit.
    expect(mockSyncToContact).toHaveBeenCalledTimes(1);
  });

  it("registration-only edit (no attendee) touches neither the attendee nor the contact store", async () => {
    const res = await PUT(req({ status: "CONFIRMED" }), { params });
    expect(res.status).toBe(200);
    expect(mockDb._tx.attendee.update).not.toHaveBeenCalled();
    expect(mockSyncToContact).not.toHaveBeenCalled();
  });
});
