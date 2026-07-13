/**
 * Integration coverage for the hybrid attendanceMode change on MCP
 * `update_registration` — the live TicketType.soldCount counter + lazy qrCode.
 * The pure seat model is unit-tested in registration-seat.test.ts; this pins
 * that the executor actually applies it to soldCount and mints/keeps the barcode.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => {
  const ticketTypeUpdate = vi.fn().mockResolvedValue({});
  const ticketTypeFindUnique = vi.fn();
  const ticketTypeUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const ticketTypeFindFirst = vi.fn();
  const regFindFirst = vi.fn();
  const regUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const regFindUniqueOrThrow = vi.fn();
  const attendeeUpdate = vi.fn().mockResolvedValue({});
  const promoUpdate = vi.fn().mockResolvedValue({});
  const tx = {
    ticketType: { update: ticketTypeUpdate, findUnique: ticketTypeFindUnique, updateMany: ticketTypeUpdateMany },
    registration: { updateMany: regUpdateMany, findUniqueOrThrow: regFindUniqueOrThrow },
    attendee: { update: attendeeUpdate },
    promoCode: { update: promoUpdate },
  };
  const db = {
    registration: { findFirst: regFindFirst },
    ticketType: { findFirst: ticketTypeFindFirst },
    // The service loads the event (settings) alongside the registration.
    event: { findFirst: vi.fn().mockResolvedValue({ id: "ev1", settings: {} }) },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
    $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    _tx: tx,
  };
  return { mockDb: db };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
vi.mock("@/lib/utils", () => ({ generateBarcode: () => "BC-TEST-MINTED", normalizeTag: (t: string) => t }));
vi.mock("@/lib/checkout-session-cleanup", () => ({ expireOpenCheckoutSessionOnCancel: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/person-tag-sync", () => ({
  computeTagDelta: vi.fn(() => ({ added: [], removed: [] })),
  syncRegistrationTagsToSpeakers: vi.fn().mockResolvedValue(undefined),
}));

import { REGISTRATION_EXECUTORS } from "@/lib/agent/tools/registrations";

const update = REGISTRATION_EXECUTORS.update_registration;
const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1", counters: { creates: 0, emailsSent: 0 } };

function existingReg(over: Record<string, unknown>) {
  return {
    id: "r1", eventId: "ev1", status: "CONFIRMED", paymentStatus: "COMPLIMENTARY",
    sponsorId: null, ticketTypeId: "T", attendeeId: "a1", promoCodeId: null,
    attendanceMode: "VIRTUAL", qrCode: null, pricingTierId: null, createdSource: "ADMIN_DASHBOARD",
    attendee: { id: "a1", firstName: "J", lastName: "D", email: "j@x.com", tags: [] },
    event: { settings: {} },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb._tx.registration.updateMany.mockResolvedValue({ count: 1 });
  mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 1 });
  mockDb._tx.registration.findUniqueOrThrow.mockResolvedValue({
    id: "r1", status: "CONFIRMED", paymentStatus: "COMPLIMENTARY", ticketTypeId: "T", notes: null,
    attendee: { id: "a1", firstName: "J", lastName: "D", email: "j@x.com" },
  });
});

describe("update_registration — hybrid attendanceMode seat + barcode", () => {
  it("virtual→in-person claims a seat + mints an entry barcode", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existingReg({ attendanceMode: "VIRTUAL", qrCode: null }));
    mockDb._tx.ticketType.findUnique.mockResolvedValue({ quantity: 100 });

    const res = (await update({ registrationId: "r1", attendanceMode: "IN_PERSON" }, ctx)) as { error?: string };
    expect(res.error).toBeUndefined();

    // claimed a seat (capacity-guarded increment), no release
    expect(mockDb._tx.ticketType.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "T" }), data: { soldCount: { increment: 1 } } }),
    );
    expect(mockDb._tx.ticketType.update).not.toHaveBeenCalled();

    // regData minted the barcode + set the mode
    const regData = mockDb._tx.registration.updateMany.mock.calls[0][0].data;
    expect(regData.attendanceMode).toBe("IN_PERSON");
    expect(regData.qrCode).toBe("BC-TEST-MINTED");
  });

  it("in-person→virtual releases the seat + keeps the existing barcode", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existingReg({ attendanceMode: "IN_PERSON", qrCode: "BC-OLD" }));

    const res = (await update({ registrationId: "r1", attendanceMode: "VIRTUAL" }, ctx)) as { error?: string };
    expect(res.error).toBeUndefined();

    // released the seat via the guarded updateMany (never below 0), no claim
    expect(mockDb._tx.ticketType.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "T", soldCount: { gte: 1 } },
        data: { soldCount: { decrement: 1 } },
      }),
    );

    const regData = mockDb._tx.registration.updateMany.mock.calls[0][0].data;
    expect(regData.attendanceMode).toBe("VIRTUAL");
    expect(regData.qrCode).toBeUndefined(); // existing barcode untouched
  });

  it("virtual→in-person on a sold-out type returns CAPACITY_EXCEEDED (reg stays virtual)", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existingReg({ attendanceMode: "VIRTUAL", qrCode: null }));
    mockDb._tx.ticketType.findUnique.mockResolvedValue({ quantity: 100 });
    mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 0 }); // full → claim fails

    const res = (await update({ registrationId: "r1", attendanceMode: "IN_PERSON" }, ctx)) as { code?: string };
    expect(res.code).toBe("CAPACITY_EXCEEDED");
    // the registration row was never updated (tx threw + rolled back)
    expect(mockDb._tx.registration.updateMany).not.toHaveBeenCalled();
  });
});
