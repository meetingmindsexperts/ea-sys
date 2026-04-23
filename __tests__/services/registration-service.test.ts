/**
 * Unit tests for src/services/registration-service.ts — Phase 2c extraction.
 * Shared by REST admin POST `/api/events/[eventId]/registrations` and
 * MCP `create_registration`. Bulk + public-register paths are OUT of scope
 * for this service.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDb,
  mockApiLogger,
  mockSyncToContact,
  mockRefreshStats,
  mockNotifyAdmins,
  mockSendConfirmation,
  mockGetNextSerialId,
  mockGenerateBarcode,
} = vi.hoisted(() => {
  return {
    mockDb: {
      event: { findFirst: vi.fn() },
      ticketType: { findFirst: vi.fn(), updateMany: vi.fn() },
      pricingTier: { findFirst: vi.fn() },
      registration: { findFirst: vi.fn(), create: vi.fn() },
      attendee: { create: vi.fn() },
      auditLog: { create: vi.fn() },
      // $transaction runs its callback with a tx proxy that points at
      // the mock methods. Lets the tx body exercise the real control flow
      // (duplicate check → attendee create → soldCount increment →
      // registration create) under vi.fn assertion.
      $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
        return cb({
          registration: {
            findFirst: (...a: unknown[]) =>
              (mockDb.registration.findFirst as (...a: unknown[]) => unknown)(...a),
            create: (...a: unknown[]) =>
              (mockDb.registration.create as (...a: unknown[]) => unknown)(...a),
          },
          attendee: {
            create: (...a: unknown[]) =>
              (mockDb.attendee.create as (...a: unknown[]) => unknown)(...a),
          },
          ticketType: {
            updateMany: (...a: unknown[]) =>
              (mockDb.ticketType.updateMany as (...a: unknown[]) => unknown)(...a),
          },
        });
      }),
    },
    mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    mockSyncToContact: vi.fn(),
    mockRefreshStats: vi.fn(),
    mockNotifyAdmins: vi.fn(),
    mockSendConfirmation: vi.fn(),
    mockGetNextSerialId: vi.fn(async () => 42),
    mockGenerateBarcode: vi.fn(() => "BARCODE-TEST-123"),
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: mockSyncToContact }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: mockRefreshStats }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: mockNotifyAdmins }));
vi.mock("@/lib/email", () => ({ sendRegistrationConfirmation: mockSendConfirmation }));
vi.mock("@/lib/registration-serial", () => ({ getNextSerialId: mockGetNextSerialId }));
vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return { ...actual, generateBarcode: mockGenerateBarcode };
});

import { createRegistration } from "@/services/registration-service";

const BASE_INPUT = {
  eventId: "evt-1",
  organizationId: "org-1",
  userId: "user-1",
  ticketTypeId: "tt-1",
  attendee: {
    email: "John@Example.com",
    firstName: "John",
    lastName: "Doe",
  },
  source: "rest" as const,
};

const PAID_EVENT = {
  id: "evt-1",
  name: "Test Conference",
  slug: "test-conf",
  startDate: new Date("2026-06-01"),
  venue: "Grand Hall",
  city: "Dubai",
  taxRate: 5,
  taxLabel: "VAT",
  bankDetails: "Bank A details",
  supportEmail: "support@example.com",
  organizationId: "org-1",
  organization: {
    name: "Test Org",
    companyName: "Test Co Ltd",
    companyAddress: "1 Street",
    companyCity: "Dubai",
    companyState: "Dubai",
    companyZipCode: "00000",
    companyCountry: "UAE",
    taxId: "TRN-1",
    logo: null,
  },
};

const PAID_TICKET = {
  id: "tt-1",
  name: "Standard",
  price: 100,
  currency: "USD",
  quantity: 100,
  soldCount: 5,
  salesStart: null,
  salesEnd: null,
  requiresApproval: false,
};

const FREE_TICKET = { ...PAID_TICKET, id: "tt-free", name: "Complimentary", price: 0 };

const CREATED_REGISTRATION_PAID = {
  id: "reg-1",
  eventId: "evt-1",
  ticketTypeId: "tt-1",
  attendeeId: "att-1",
  serialId: 42,
  status: "CONFIRMED",
  paymentStatus: "UNASSIGNED",
  qrCode: "BARCODE-TEST-123",
  notes: null,
  attendee: {
    id: "att-1",
    email: "john@example.com",
    firstName: "John",
    lastName: "Doe",
  },
  ticketType: { id: "tt-1", name: "Standard", price: 100, currency: "USD" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(PAID_EVENT);
  mockDb.ticketType.findFirst.mockResolvedValue(PAID_TICKET);
  mockDb.registration.findFirst.mockResolvedValue(null);
  mockDb.attendee.create.mockResolvedValue({ id: "att-1" });
  mockDb.ticketType.updateMany.mockResolvedValue({ count: 1 });
  mockDb.registration.create.mockResolvedValue(CREATED_REGISTRATION_PAID);
  mockDb.auditLog.create.mockResolvedValue({});
  mockSyncToContact.mockResolvedValue(undefined);
  mockNotifyAdmins.mockResolvedValue(undefined);
  mockSendConfirmation.mockResolvedValue({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("createRegistration — happy path", () => {
  it("returns ok=true with the created registration (REST paid, outstanding → email fires)", async () => {
    const result = await createRegistration(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.registration.id).toBe("reg-1");
      expect(result.registration.paymentStatus).toBe("UNASSIGNED");
    }
  });

  it("normalizes email to lowercase + trim before lookup and create", async () => {
    await createRegistration({
      ...BASE_INPUT,
      attendee: { ...BASE_INPUT.attendee, email: "  JOHN@Example.COM  " },
    });
    // Duplicate-check used normalized email
    const dupCall = mockDb.registration.findFirst.mock.calls[0][0];
    expect(dupCall.where.attendee.email).toBe("john@example.com");
    // Attendee create used normalized email
    const attCreate = mockDb.attendee.create.mock.calls[0][0];
    expect(attCreate.data.email).toBe("john@example.com");
  });

  it("defaults paymentStatus to UNASSIGNED for paid tickets", async () => {
    await createRegistration(BASE_INPUT);
    const regCreate = mockDb.registration.create.mock.calls[0][0];
    expect(regCreate.data.paymentStatus).toBe("UNASSIGNED");
  });

  it("defaults paymentStatus to COMPLIMENTARY for free tickets (price=0)", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(FREE_TICKET);
    mockDb.registration.create.mockResolvedValue({
      ...CREATED_REGISTRATION_PAID,
      paymentStatus: "COMPLIMENTARY",
    });
    await createRegistration({ ...BASE_INPUT, ticketTypeId: "tt-free" });
    const regCreate = mockDb.registration.create.mock.calls[0][0];
    expect(regCreate.data.paymentStatus).toBe("COMPLIMENTARY");
  });

  it("defaults paymentStatus to COMPLIMENTARY when no ticketTypeId is given", async () => {
    await createRegistration({ ...BASE_INPUT, ticketTypeId: null });
    const regCreate = mockDb.registration.create.mock.calls[0][0];
    expect(regCreate.data.paymentStatus).toBe("COMPLIMENTARY");
  });

  it("forces status=PENDING when ticketType.requiresApproval is true", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({ ...PAID_TICKET, requiresApproval: true });
    await createRegistration({ ...BASE_INPUT, status: "CONFIRMED" });
    const regCreate = mockDb.registration.create.mock.calls[0][0];
    expect(regCreate.data.status).toBe("PENDING");
  });

  it("honors caller-supplied status (WAITLISTED) when requiresApproval=false", async () => {
    await createRegistration({ ...BASE_INPUT, status: "WAITLISTED" });
    const regCreate = mockDb.registration.create.mock.calls[0][0];
    expect(regCreate.data.status).toBe("WAITLISTED");
  });

  it("atomically increments ticketType.soldCount inside the transaction", async () => {
    await createRegistration(BASE_INPUT);
    expect(mockDb.ticketType.updateMany).toHaveBeenCalledWith({
      where: { id: "tt-1", soldCount: { lt: 100 } },
      data: { soldCount: { increment: 1 } },
    });
  });

  it("skips soldCount increment when no ticketTypeId provided", async () => {
    await createRegistration({ ...BASE_INPUT, ticketTypeId: null });
    expect(mockDb.ticketType.updateMany).not.toHaveBeenCalled();
  });

  it("generates and persists qrCode via generateBarcode()", async () => {
    await createRegistration(BASE_INPUT);
    const regCreate = mockDb.registration.create.mock.calls[0][0];
    expect(regCreate.data.qrCode).toBe("BARCODE-TEST-123");
  });

  it("syncs to Contact store with the full payload", async () => {
    await createRegistration({
      ...BASE_INPUT,
      attendee: {
        ...BASE_INPUT.attendee,
        title: "DR",
        organization: "MIT",
        jobTitle: "Prof",
        phone: "+1234",
        photo: "/uploads/photos/john.jpg",
        city: "Boston",
        country: "USA",
        bio: "Bio text",
        specialty: "Cardiology",
      },
    });
    const call = mockSyncToContact.mock.calls[0][0];
    expect(call).toMatchObject({
      organizationId: "org-1",
      eventId: "evt-1",
      email: "john@example.com",
      firstName: "John",
      lastName: "Doe",
      title: "DR",
      organization: "MIT",
      jobTitle: "Prof",
      phone: "+1234",
      photo: "/uploads/photos/john.jpg",
      city: "Boston",
      country: "USA",
      bio: "Bio text",
      specialty: "Cardiology",
      registrationType: "Standard",
    });
  });

  it("writes audit log with source=rest + ip when requestIp provided", async () => {
    await createRegistration({ ...BASE_INPUT, requestIp: "1.2.3.4" });
    const auditCall = mockDb.auditLog.create.mock.calls[0][0];
    expect(auditCall.data).toMatchObject({
      eventId: "evt-1",
      userId: "user-1",
      action: "CREATE",
      entityType: "Registration",
      entityId: "reg-1",
      changes: expect.objectContaining({
        source: "rest",
        ticketTypeId: "tt-1",
        paymentStatus: "UNASSIGNED",
        status: "CONFIRMED",
        ip: "1.2.3.4",
      }),
    });
  });

  it("writes audit log with source=mcp and no ip for MCP caller", async () => {
    await createRegistration({ ...BASE_INPUT, source: "mcp" });
    const auditCall = mockDb.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.changes.source).toBe("mcp");
    expect(auditCall.data.changes.ip).toBeUndefined();
  });

  it("notifies admins with actor name for REST callers", async () => {
    await createRegistration({ ...BASE_INPUT, actorFirstName: "Alice" });
    const call = mockNotifyAdmins.mock.calls[0];
    expect(call[1].message).toBe("John Doe added by Alice");
  });

  it("notifies admins with 'via MCP' suffix for MCP callers", async () => {
    await createRegistration({ ...BASE_INPUT, source: "mcp" });
    const call = mockNotifyAdmins.mock.calls[0];
    expect(call[1].message).toBe("John Doe added via MCP");
  });

  it("falls back to 'organizer' when REST caller has no first name", async () => {
    await createRegistration({ ...BASE_INPUT, actorFirstName: null });
    const call = mockNotifyAdmins.mock.calls[0];
    expect(call[1].message).toBe("John Doe added by organizer");
  });

  it("refreshes event stats after commit", async () => {
    await createRegistration(BASE_INPUT);
    expect(mockRefreshStats).toHaveBeenCalledWith("evt-1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Confirmation email gating
// ─────────────────────────────────────────────────────────────────────────────

describe("createRegistration — confirmation email gating", () => {
  it("sends confirmation when paid ticket + UNASSIGNED (default)", async () => {
    await createRegistration(BASE_INPUT);
    expect(mockSendConfirmation).toHaveBeenCalledTimes(1);
    const call = mockSendConfirmation.mock.calls[0][0];
    expect(call.to).toBe("john@example.com");
    expect(call.ticketPrice).toBe(100);
    expect(call.organizationName).toBe("Test Org");
  });

  it("skips confirmation when paymentStatus=PAID (admin settled)", async () => {
    mockDb.registration.create.mockResolvedValue({
      ...CREATED_REGISTRATION_PAID,
      paymentStatus: "PAID",
    });
    await createRegistration({ ...BASE_INPUT, paymentStatus: "PAID" });
    expect(mockSendConfirmation).not.toHaveBeenCalled();
  });

  it("skips confirmation when paymentStatus=COMPLIMENTARY", async () => {
    mockDb.registration.create.mockResolvedValue({
      ...CREATED_REGISTRATION_PAID,
      paymentStatus: "COMPLIMENTARY",
    });
    await createRegistration({ ...BASE_INPUT, paymentStatus: "COMPLIMENTARY" });
    expect(mockSendConfirmation).not.toHaveBeenCalled();
  });

  it("skips confirmation for free tickets (price=0)", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(FREE_TICKET);
    mockDb.registration.create.mockResolvedValue({
      ...CREATED_REGISTRATION_PAID,
      paymentStatus: "COMPLIMENTARY",
    });
    await createRegistration({ ...BASE_INPUT, ticketTypeId: "tt-free" });
    expect(mockSendConfirmation).not.toHaveBeenCalled();
  });

  it("skips confirmation when no ticketType is assigned", async () => {
    await createRegistration({ ...BASE_INPUT, ticketTypeId: null });
    expect(mockSendConfirmation).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Domain errors
// ─────────────────────────────────────────────────────────────────────────────

describe("createRegistration — domain errors", () => {
  it("EVENT_NOT_FOUND when event lookup returns null (cross-org)", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const result = await createRegistration(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EVENT_NOT_FOUND");
    expect(mockDb.registration.create).not.toHaveBeenCalled();
  });

  it("TICKET_TYPE_NOT_FOUND when ticketType lookup returns null", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(null);
    const result = await createRegistration(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TICKET_TYPE_NOT_FOUND");
  });

  it("SALES_NOT_STARTED when salesStart is in the future", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({
      ...PAID_TICKET,
      salesStart: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const result = await createRegistration(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SALES_NOT_STARTED");
  });

  it("SALES_ENDED when salesEnd is in the past", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({
      ...PAID_TICKET,
      salesEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    const result = await createRegistration(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SALES_ENDED");
  });

  it("SOLD_OUT when soldCount already at quantity (pre-tx check)", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({
      ...PAID_TICKET,
      soldCount: 100,
      quantity: 100,
    });
    const result = await createRegistration(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SOLD_OUT");
  });

  it("SOLD_OUT when in-tx updateMany matches zero rows (race)", async () => {
    // Pre-check passes (5 < 100), but by the time the tx runs, the increment
    // matches zero rows (another concurrent writer hit the cap first).
    mockDb.ticketType.updateMany.mockResolvedValue({ count: 0 });
    const result = await createRegistration(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SOLD_OUT");
    expect(mockDb.registration.create).not.toHaveBeenCalled();
  });

  it("PRICING_TIER_NOT_FOUND when pricingTierId doesn't belong to ticketType", async () => {
    mockDb.pricingTier.findFirst.mockResolvedValue(null);
    const result = await createRegistration({ ...BASE_INPUT, pricingTierId: "missing" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PRICING_TIER_NOT_FOUND");
  });

  it("ALREADY_REGISTERED when non-cancelled registration exists for this email", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "reg-existing" });
    const result = await createRegistration(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ALREADY_REGISTERED");
      expect(result.meta).toEqual({ existingRegistrationId: "reg-existing" });
    }
  });

  it("duplicate check excludes CANCELLED status (re-registration allowed)", async () => {
    await createRegistration(BASE_INPUT);
    const dupCall = mockDb.registration.findFirst.mock.calls[0][0];
    expect(dupCall.where.status).toEqual({ notIn: ["CANCELLED"] });
  });

  it("INVALID_PAYMENT_STATUS when caller passes a Stripe-driven state (PENDING)", async () => {
    const result = await createRegistration({
      ...BASE_INPUT,
      paymentStatus: "PENDING" as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PAYMENT_STATUS");
    expect(mockDb.registration.create).not.toHaveBeenCalled();
  });

  it("INVALID_PAYMENT_STATUS when caller passes REFUNDED", async () => {
    const result = await createRegistration({
      ...BASE_INPUT,
      paymentStatus: "REFUNDED" as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PAYMENT_STATUS");
  });

  it("UNKNOWN for unexpected transaction failures (DB down)", async () => {
    mockDb.$transaction.mockRejectedValueOnce(new Error("Connection refused"));
    const result = await createRegistration(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN");
      expect(result.message).toContain("Connection refused");
    }
    // Post-commit side effects must not fire on failure
    expect(mockSyncToContact).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockNotifyAdmins).not.toHaveBeenCalled();
    expect(mockSendConfirmation).not.toHaveBeenCalled();
    expect(mockRefreshStats).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Side-effect non-blocking behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("createRegistration — side-effect isolation", () => {
  it("audit-log failure is non-blocking (happy path still returns ok=true)", async () => {
    mockDb.auditLog.create.mockRejectedValue(new Error("audit DB down"));
    const result = await createRegistration(BASE_INPUT);
    expect(result.ok).toBe(true);
  });

  it("notifyEventAdmins failure is non-blocking", async () => {
    mockNotifyAdmins.mockRejectedValue(new Error("notify down"));
    const result = await createRegistration(BASE_INPUT);
    expect(result.ok).toBe(true);
  });

  it("confirmation email failure is non-blocking", async () => {
    mockSendConfirmation.mockRejectedValue(new Error("Brevo down"));
    const result = await createRegistration(BASE_INPUT);
    expect(result.ok).toBe(true);
  });
});
