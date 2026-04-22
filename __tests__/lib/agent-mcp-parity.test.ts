/**
 * Phase 0 parity tests — verify MCP write tools fire the same side effects as
 * their REST counterparts. Added after the April 2026 audit that found MCP
 * `create_registration` silently skipped the confirmation email + quote PDF
 * for paid tickets (and related drift on `create_speaker`, bulk creates).
 *
 * Scope is narrow: we mock `db`, `email`, `notifications`, `contact-sync`, and
 * `event-stats`, then call the executor through its public surface
 * (REGISTRATION_EXECUTORS / SPEAKER_EXECUTORS) and assert the right helpers
 * get invoked with the right shapes. Full DB integration lives in e2e tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted so the mock module is registered before imports resolve) ──

const { mockDb, mockEmail, mockNotifications, mockContactSync, mockEventStats, mockApiLogger } = vi.hoisted(() => {
  return {
    mockDb: {
      event: { findFirst: vi.fn() },
      ticketType: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
      pricingTier: { findFirst: vi.fn() },
      registration: { findFirst: vi.fn(), create: vi.fn() },
      attendee: { create: vi.fn() },
      speaker: { findFirst: vi.fn(), create: vi.fn() },
      auditLog: { create: vi.fn() },
      // $transaction receives a callback — invoke it with a tx proxy that
      // points at the same mock methods.
      $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
        return cb({
          attendee: { create: (...args: unknown[]) => (mockDb.attendee.create as (...a: unknown[]) => unknown)(...args) },
          ticketType: {
            findUnique: (...args: unknown[]) => (mockDb.ticketType.findUnique as (...a: unknown[]) => unknown)(...args),
            updateMany: (...args: unknown[]) => (mockDb.ticketType.updateMany as (...a: unknown[]) => unknown)(...args),
          },
          registration: { create: (...args: unknown[]) => (mockDb.registration.create as (...a: unknown[]) => unknown)(...args) },
        });
      }),
    },
    mockEmail: { sendRegistrationConfirmation: vi.fn() },
    mockNotifications: { notifyEventAdmins: vi.fn() },
    mockContactSync: { syncToContact: vi.fn() },
    mockEventStats: { refreshEventStats: vi.fn() },
    mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/email", () => ({ sendRegistrationConfirmation: mockEmail.sendRegistrationConfirmation }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: mockNotifications.notifyEventAdmins }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: mockContactSync.syncToContact }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: mockEventStats.refreshEventStats }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/registration-serial", () => ({ getNextSerialId: vi.fn(async () => 42) }));
vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return { ...actual, generateBarcode: vi.fn(() => "BARCODE-TEST-123") };
});

import { REGISTRATION_EXECUTORS } from "@/lib/agent/tools/registrations";
import { SPEAKER_EXECUTORS } from "@/lib/agent/tools/speakers";

const CTX = {
  eventId: "evt-1",
  organizationId: "org-1",
  userId: "user-1",
  counters: { creates: 0, emailsSent: 0 },
};

// Reused fixture — a paid-event loaded by `findFirst` with all fields the
// confirmation email needs.
const paidEvent = {
  id: "evt-1",
  name: "Test Conference",
  slug: "test-conf",
  startDate: new Date("2026-06-01"),
  venue: "Conference Center",
  city: "Dubai",
  taxRate: 5,
  taxLabel: "VAT",
  bankDetails: "Bank A",
  supportEmail: "support@example.com",
  organizationId: "org-1",
  organization: {
    name: "Test Org",
    companyName: "Test Co",
    companyAddress: "123 St",
    companyCity: "Dubai",
    companyState: "Dubai",
    companyZipCode: "00000",
    companyCountry: "UAE",
    taxId: "TX-1",
    logo: null,
  },
};

const paidTicket = {
  id: "tt-1",
  name: "Standard",
  price: 100,
  currency: "USD",
  quantity: 100,
  soldCount: 0,
  salesStart: null,
  salesEnd: null,
  requiresApproval: false,
};

const freeTicket = { ...paidTicket, id: "tt-free", name: "Complimentary", price: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: no existing registration, attendee/registration create returns a
  // freshly-minted row. Individual tests override as needed.
  mockDb.event.findFirst.mockResolvedValue(paidEvent);
  mockDb.ticketType.findFirst.mockResolvedValue(paidTicket);
  mockDb.registration.findFirst.mockResolvedValue(null);
  mockDb.attendee.create.mockResolvedValue({
    id: "att-1",
    firstName: "John",
    lastName: "Doe",
    email: "john@example.com",
  });
  mockDb.ticketType.updateMany.mockResolvedValue({ count: 1 });
  mockDb.registration.create.mockResolvedValue({
    id: "reg-1",
    status: "CONFIRMED",
    paymentStatus: "UNASSIGNED",
    serialId: 42,
    qrCode: "BARCODE-TEST-123",
    ticketType: { name: "Standard" },
  });
  mockDb.auditLog.create.mockResolvedValue({});
  mockContactSync.syncToContact.mockResolvedValue(undefined);
  mockNotifications.notifyEventAdmins.mockResolvedValue(undefined);
  mockEmail.sendRegistrationConfirmation.mockResolvedValue({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// create_registration
// ─────────────────────────────────────────────────────────────────────────────

describe("MCP create_registration — REST parity", () => {
  const baseInput = {
    email: "john@example.com",
    firstName: "John",
    lastName: "Doe",
    ticketTypeId: "tt-1",
  };

  it("sends confirmation email + quote PDF when ticket is paid and payment is outstanding (UNASSIGNED default)", async () => {
    const result = await REGISTRATION_EXECUTORS.create_registration(baseInput, CTX) as { success: boolean };
    expect(result.success).toBe(true);
    expect(mockEmail.sendRegistrationConfirmation).toHaveBeenCalledTimes(1);
    const call = mockEmail.sendRegistrationConfirmation.mock.calls[0][0];
    expect(call.to).toBe("john@example.com");
    expect(call.ticketPrice).toBe(100);
    expect(call.organizationName).toBe("Test Org");
    expect(call.logoPath).toBe(null);
  });

  it("skips confirmation email when caller sets paymentStatus=PAID (admin-settled)", async () => {
    await REGISTRATION_EXECUTORS.create_registration(
      { ...baseInput, paymentStatus: "PAID" },
      CTX,
    );
    expect(mockEmail.sendRegistrationConfirmation).not.toHaveBeenCalled();
  });

  it("skips confirmation email when caller sets paymentStatus=COMPLIMENTARY", async () => {
    await REGISTRATION_EXECUTORS.create_registration(
      { ...baseInput, paymentStatus: "COMPLIMENTARY" },
      CTX,
    );
    expect(mockEmail.sendRegistrationConfirmation).not.toHaveBeenCalled();
  });

  it("skips confirmation email for free tickets (defaults to COMPLIMENTARY)", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(freeTicket);
    await REGISTRATION_EXECUTORS.create_registration(
      { ...baseInput, ticketTypeId: "tt-free" },
      CTX,
    );
    expect(mockEmail.sendRegistrationConfirmation).not.toHaveBeenCalled();
    // Registration row should have been created with COMPLIMENTARY.
    const regCreate = mockDb.registration.create.mock.calls[0][0];
    expect(regCreate.data.paymentStatus).toBe("COMPLIMENTARY");
  });

  it("defaults paymentStatus to UNASSIGNED for paid tickets when caller omits it", async () => {
    await REGISTRATION_EXECUTORS.create_registration(baseInput, CTX);
    const regCreate = mockDb.registration.create.mock.calls[0][0];
    expect(regCreate.data.paymentStatus).toBe("UNASSIGNED");
  });

  it("rejects Stripe-driven paymentStatus values (PENDING/REFUNDED/FAILED) — webhook-owned", async () => {
    const r1 = await REGISTRATION_EXECUTORS.create_registration(
      { ...baseInput, paymentStatus: "REFUNDED" },
      CTX,
    ) as { error?: string };
    expect(r1.error).toMatch(/Invalid paymentStatus/);
    expect(mockDb.registration.create).not.toHaveBeenCalled();
  });

  it("forces status=PENDING when ticket type requires approval (ignoring caller input)", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({ ...paidTicket, requiresApproval: true });
    await REGISTRATION_EXECUTORS.create_registration(
      { ...baseInput, status: "CONFIRMED" },
      CTX,
    );
    const regCreate = mockDb.registration.create.mock.calls[0][0];
    expect(regCreate.data.status).toBe("PENDING");
  });

  it("atomically increments soldCount inside the transaction with a sold-out guard", async () => {
    await REGISTRATION_EXECUTORS.create_registration(baseInput, CTX);
    expect(mockDb.ticketType.updateMany).toHaveBeenCalledWith({
      where: { id: "tt-1", soldCount: { lt: 100 } },
      data: { soldCount: { increment: 1 } },
    });
  });

  it("returns a user-visible SOLD_OUT error when updateMany matches zero rows (race)", async () => {
    mockDb.ticketType.updateMany.mockResolvedValue({ count: 0 });
    const result = await REGISTRATION_EXECUTORS.create_registration(baseInput, CTX) as { error?: string };
    expect(result.error).toMatch(/sold out/i);
  });

  it("generates and persists a qrCode on the registration row", async () => {
    await REGISTRATION_EXECUTORS.create_registration(baseInput, CTX);
    const regCreate = mockDb.registration.create.mock.calls[0][0];
    expect(regCreate.data.qrCode).toBe("BARCODE-TEST-123");
  });

  it("calls syncToContact, notifyEventAdmins, writes audit log, and refreshes stats", async () => {
    await REGISTRATION_EXECUTORS.create_registration(baseInput, CTX);
    expect(mockContactSync.syncToContact).toHaveBeenCalledTimes(1);
    expect(mockContactSync.syncToContact.mock.calls[0][0]).toMatchObject({
      organizationId: "org-1",
      eventId: "evt-1",
      email: "john@example.com",
      registrationType: "Standard",
    });
    expect(mockNotifications.notifyEventAdmins).toHaveBeenCalledWith("evt-1", expect.objectContaining({
      type: "REGISTRATION",
      title: "Registration Added",
    }));
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CREATE",
        entityType: "Registration",
        changes: expect.objectContaining({ source: "mcp" }),
      }),
    });
    expect(mockEventStats.refreshEventStats).toHaveBeenCalledWith("evt-1");
  });

  it("rejects registration when sales window has not started", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({
      ...paidTicket,
      salesStart: new Date(Date.now() + 24 * 60 * 60 * 1000), // tomorrow
    });
    const result = await REGISTRATION_EXECUTORS.create_registration(baseInput, CTX) as { error?: string };
    expect(result.error).toMatch(/not started/i);
    expect(mockDb.registration.create).not.toHaveBeenCalled();
  });

  it("rejects registration when sales window has ended", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({
      ...paidTicket,
      salesEnd: new Date(Date.now() - 24 * 60 * 60 * 1000), // yesterday
    });
    const result = await REGISTRATION_EXECUTORS.create_registration(baseInput, CTX) as { error?: string };
    expect(result.error).toMatch(/ended/i);
  });

  it("duplicate check excludes CANCELLED registrations (matches REST behavior)", async () => {
    await REGISTRATION_EXECUTORS.create_registration(baseInput, CTX);
    expect(mockDb.registration.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        eventId: "evt-1",
        attendee: { email: "john@example.com" },
        status: { notIn: ["CANCELLED"] },
      }),
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create_speaker
// ─────────────────────────────────────────────────────────────────────────────

describe("MCP create_speaker — REST parity", () => {
  const baseInput = {
    email: "alice@example.com",
    firstName: "Alice",
    lastName: "Smith",
  };

  beforeEach(() => {
    mockDb.speaker.findFirst.mockResolvedValue(null);
    mockDb.speaker.create.mockResolvedValue({
      id: "spk-1",
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
      status: "INVITED",
    });
  });

  it("creates speaker and returns success", async () => {
    const result = await SPEAKER_EXECUTORS.create_speaker(baseInput, CTX) as { success: boolean; speaker: { id: string } };
    expect(result.success).toBe(true);
    expect(result.speaker.id).toBe("spk-1");
  });

  it("calls syncToContact with the full payload (phone/photo/city/country/bio/registrationType)", async () => {
    await SPEAKER_EXECUTORS.create_speaker(
      {
        ...baseInput,
        title: "DR",
        bio: "Bio text",
        organization: "MIT",
        jobTitle: "Prof",
        phone: "+1234",
        city: "Boston",
        country: "USA",
        photo: "/uploads/photos/alice.jpg",
        specialty: "Cardiology",
        registrationType: "Speaker",
      },
      CTX,
    );
    const call = mockContactSync.syncToContact.mock.calls[0][0];
    expect(call).toMatchObject({
      organizationId: "org-1",
      eventId: "evt-1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
      title: "DR",
      organization: "MIT",
      jobTitle: "Prof",
      phone: "+1234",
      photo: "/uploads/photos/alice.jpg",
      city: "Boston",
      country: "USA",
      bio: "Bio text",
      specialty: "Cardiology",
      registrationType: "Speaker",
    });
  });

  it("writes audit log with source=mcp and notifies org admins", async () => {
    await SPEAKER_EXECUTORS.create_speaker(baseInput, CTX);
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CREATE",
        entityType: "Speaker",
        changes: expect.objectContaining({ source: "mcp" }),
      }),
    });
    expect(mockNotifications.notifyEventAdmins).toHaveBeenCalledWith("evt-1", expect.objectContaining({
      type: "REGISTRATION",
      title: "Speaker Added",
    }));
  });

  it("refuses creation when a speaker with the same email already exists (returns existingId)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "existing-spk" });
    const result = await SPEAKER_EXECUTORS.create_speaker(baseInput, CTX) as { error?: string; existingId?: string };
    expect(result.error).toMatch(/already exists/i);
    expect(result.existingId).toBe("existing-spk");
    expect(mockDb.speaker.create).not.toHaveBeenCalled();
  });
});
