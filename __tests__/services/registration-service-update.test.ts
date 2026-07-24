/**
 * registration-service.updateRegistration — the ONE update implementation
 * (cross-caller #5, July 13 2026). Previously hand-mirrored between the REST
 * PUT and MCP `update_registration` with live drift; these pin the unified
 * contract, especially the three MED/LOW fixes folded into the extraction:
 *
 *  - M1: the lookup binds to the caller's EVENT ({id, eventId}) — a
 *    mis-scoped agent call can't mutate a sibling event's registration;
 *  - M7: the INCLUSIVE↔sponsor invariant fires only when the request touches
 *    paymentStatus/sponsorId (MCP used to hard-block ANY edit to a legacy
 *    INCLUSIVE-without-sponsor row);
 *  - L4: attendee empty strings clear fields to null on every path (MCP used
 *    to persist "").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => {
  const tx = {
    ticketType: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    event: {
      findUnique: vi.fn().mockResolvedValue({ seatCount: 0, maxAttendees: null }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: vi.fn(async () => 1),
    pricingTier: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    registration: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn(),
    },
    attendee: { update: vi.fn().mockResolvedValue({}) },
    promoCode: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  return {
    mockDb: {
      registration: { findFirst: vi.fn() },
      event: { findFirst: vi.fn() },
      ticketType: { findFirst: vi.fn(), findUnique: vi.fn() },
      pricingTier: { findFirst: vi.fn() },
      billingAccount: { findFirst: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      _tx: tx,
    },
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendRegistrationConfirmation: vi.fn() }));
vi.mock("@/lib/registration-confirmation", () => ({ buildEventConfirmationFields: vi.fn(() => ({})) }));
vi.mock("@/lib/registration-serial", () => ({ getNextSerialId: vi.fn(async () => 1) }));
const expireSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/checkout-session-cleanup", () => ({ expireOpenCheckoutSessionOnCancel: expireSpy }));
const tagSyncSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/person-tag-sync", () => ({
  computeTagDelta: vi.fn(() => ({ added: [], removed: [] })),
  syncRegistrationTagsToSpeakers: tagSyncSpy,
}));
// registration-seat / -seat-db / -repricing are REAL (pure or tx-driven).

import { updateRegistration } from "@/services/registration-service";

const base = {
  eventId: "ev1",
  organizationId: "org1",
  actorUserId: "u1",
  source: "rest" as const,
  registrationId: "reg1",
};

function existing(over: Record<string, unknown> = {}) {
  return {
    id: "reg1", eventId: "ev1", status: "CONFIRMED", paymentStatus: "UNPAID",
    sponsorId: null, ticketTypeId: "tt1", attendeeId: "att1", promoCodeId: null,
    discountAmount: null, attendanceMode: "IN_PERSON", qrCode: "QR",
    pricingTierId: null, createdSource: null,
    attendee: { id: "att1", firstName: "A", lastName: "B", email: "a@b.com", tags: [], registrationType: "Physician" },
    ...over,
  };
}

const UPDATED_ROW = {
  id: "reg1", status: "CONFIRMED", paymentStatus: "UNPAID", ticketTypeId: "tt1",
  notes: null, refundedAmount: 0, discountAmount: null,
  attendee: { id: "att1", firstName: "A", lastName: "B", email: "a@b.com" },
  ticketType: { name: "Physician", price: 100, currency: "USD" },
  pricingTier: null, payments: [], accommodation: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registration.findFirst.mockResolvedValue(existing());
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: {} });
  mockDb._tx.registration.updateMany.mockResolvedValue({ count: 1 });
  mockDb._tx.registration.findUniqueOrThrow.mockResolvedValue(UPDATED_ROW);
  mockDb._tx.ticketType.findUnique.mockResolvedValue({ quantity: 100, name: "Nurse" });
});

describe("M1 — event-bound lookup", () => {
  it("binds the registration lookup to {id, eventId}, not just the org", async () => {
    await updateRegistration({ ...base, notes: "x" });
    expect(mockDb.registration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reg1", eventId: "ev1" } }),
    );
  });

  it("a registration from a sibling event → REGISTRATION_NOT_FOUND", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null); // {id, eventId} misses
    const r = await updateRegistration({ ...base, notes: "x" });
    expect(r).toMatchObject({ ok: false, code: "REGISTRATION_NOT_FOUND" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});

describe("M7 — change-scoped sponsor invariant", () => {
  it("an unrelated edit on a legacy INCLUSIVE-without-sponsor row saves fine", async () => {
    mockDb.registration.findFirst.mockResolvedValue(
      existing({ paymentStatus: "INCLUSIVE", sponsorId: null }),
    );
    const r = await updateRegistration({ ...base, notes: "fix a typo" });
    expect(r.ok).toBe(true);
  });

  it("setting INCLUSIVE without a sponsor is still rejected", async () => {
    const r = await updateRegistration({ ...base, paymentStatus: "INCLUSIVE" });
    expect(r).toMatchObject({ ok: false, code: "INCLUSIVE_REQUIRES_SPONSOR" });
  });

  it("an unknown sponsor id is rejected with the available list", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1",
      settings: { sponsors: [{ id: "sp1", name: "Abbott", tier: "gold", sortOrder: 0 }] },
    });
    const r = await updateRegistration({ ...base, paymentStatus: "INCLUSIVE", sponsorId: "ghost" });
    expect(r).toMatchObject({
      ok: false,
      code: "SPONSOR_NOT_FOUND",
      meta: { availableSponsors: [{ id: "sp1", name: "Abbott" }] },
    });
  });
});

describe("L4 — empty-string clears to null on every path", () => {
  it('attendee.organization: "" is persisted as null (was "" via MCP)', async () => {
    await updateRegistration({ ...base, attendee: { organization: "", phone: "" } });
    expect(mockDb._tx.attendee.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organization: null, phone: null }) }),
    );
  });

  it("undefined attendee fields are left untouched", async () => {
    await updateRegistration({ ...base, attendee: { firstName: "New" } });
    const data = mockDb._tx.attendee.update.mock.calls[0][0].data;
    expect(data).toEqual({ firstName: "New" });
  });
});

describe("guards + sentinels come back as result values", () => {
  it("PAYMENT_STATUS_NOT_SETTABLE for Stripe-owned values", async () => {
    const r = await updateRegistration({ ...base, paymentStatus: "REFUNDED" });
    expect(r).toMatchObject({ ok: false, code: "PAYMENT_STATUS_NOT_SETTABLE" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("STALE_WRITE when the optimistic lock loses", async () => {
    mockDb._tx.registration.updateMany.mockResolvedValue({ count: 0 });
    const r = await updateRegistration({
      ...base, notes: "x", expectedUpdatedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(r).toMatchObject({ ok: false, code: "STALE_WRITE" });
  });

  it("UNIQUE_CONSTRAINT (dtcmBarcode) surfaces the friendly message", async () => {
    // Once — a plain mockRejectedValue would replace the implementation for
    // every later test (clearAllMocks resets calls, not implementations).
    mockDb.$transaction.mockRejectedValueOnce(
      Object.assign(new Error("P2002"), { code: "P2002", meta: { target: ["dtcmBarcode"] } }),
    );
    const r = await updateRegistration({ ...base, dtcmBarcode: "DUP" });
    expect(r).toMatchObject({ ok: false, code: "UNIQUE_CONSTRAINT" });
    if (!r.ok) expect(r.message).toContain("DTCM barcode");
  });

  it("TICKET_TYPE_NOT_FOUND is event-scoped", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(null);
    const r = await updateRegistration({ ...base, ticketTypeId: "tt-foreign" });
    expect(r).toMatchObject({ ok: false, code: "TICKET_TYPE_NOT_FOUND" });
    expect(mockDb.ticketType.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tt-foreign", eventId: "ev1" } }),
    );
  });
});

describe("post-commit fan-out", () => {
  it("a cancel expires the open checkout session + audits with full before/after", async () => {
    const r = await updateRegistration({ ...base, status: "CANCELLED" });
    expect(r.ok).toBe(true);
    expect(expireSpy).toHaveBeenCalledWith("reg1", "registration-update-rest");
    await new Promise((res) => setTimeout(res, 0));
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "UPDATE",
          changes: expect.objectContaining({
            source: "rest",
            before: expect.objectContaining({ status: "CONFIRMED" }),
            after: expect.objectContaining({ id: "reg1" }),
          }),
        }),
      }),
    );
  });

  it("a tag change mirrors onto the speaker facet", async () => {
    await updateRegistration({ ...base, attendee: { tags: ["Committee"] } });
    expect(tagSyncSpy).toHaveBeenCalledTimes(1);
  });

  it("an audit-insert blip never fails the committed update (M13 class)", async () => {
    mockDb.auditLog.create.mockRejectedValue(new Error("pool timeout"));
    const r = await updateRegistration({ ...base, notes: "x" });
    expect(r.ok).toBe(true);
  });
});
