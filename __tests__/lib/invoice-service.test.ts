import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks (required for vi.mock factory) ─────────────────────────────

const {
  mockTransaction, mockFindUniqueOrThrow, mockFindFirst,
  mockCreate, mockUpdate, mockUpdateMany,
} = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
  mockFindUniqueOrThrow: vi.fn(),
  mockFindFirst: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mockTransaction,
    registration: { findUniqueOrThrow: mockFindUniqueOrThrow },
    invoice: {
      findUniqueOrThrow: vi.fn(),
      findFirst: mockFindFirst,
      create: mockCreate,
      update: mockUpdate,
      updateMany: mockUpdateMany,
    },
    invoiceCounter: { upsert: vi.fn() },
  },
}));

vi.mock("@/lib/invoice-numbering", () => ({
  getNextInvoiceNumber: vi.fn().mockResolvedValue({
    sequenceNumber: 1,
    invoiceNumber: "INV-2026-0001",
  }),
}));

vi.mock("@/lib/invoice-pdf", () => ({
  generateInvoicePDF: vi.fn().mockResolvedValue(Buffer.from("fake-pdf")),
}));

vi.mock("@/lib/receipt-pdf", () => ({
  generateReceiptPDF: vi.fn().mockResolvedValue(Buffer.from("fake-pdf")),
}));

vi.mock("@/lib/credit-note-pdf", () => ({
  generateCreditNotePDF: vi.fn().mockResolvedValue(Buffer.from("fake-pdf")),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/utils", () => ({
  getTitleLabel: vi.fn((t: string) => t === "DR" ? "Dr." : ""),
  formatDate: vi.fn((d: Date) => d.toISOString().split("T")[0]),
}));

import { createInvoice, createReceipt, createCreditNote, cancelInvoice } from "@/lib/invoice-service";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const fakeRegistration = {
  id: "reg-1",
  eventId: "evt-1",
  billingAddress: "123 Main St",
  billingCity: "Dubai",
  billingState: null,
  billingZipCode: "00000",
  billingCountry: "UAE",
  taxNumber: "AE123",
  attendee: {
    firstName: "John",
    lastName: "Doe",
    email: "john@example.com",
    organization: "ACME Corp",
    title: "DR",
    jobTitle: "CEO",
  },
  ticketType: { name: "Standard", price: "100.00", currency: "USD" },
  pricingTier: null,
  event: {
    name: "Test Conference",
    code: "HFC2026",
    startDate: new Date("2026-06-01"),
    venue: "Dubai World Trade Centre",
    city: "Dubai",
    taxRate: "5.00",
    taxLabel: "VAT",
    bankDetails: "Bank: ABC\nAccount: 123",
    supportEmail: "support@test.com",
    organization: {
      name: "MeetingMinds",
      primaryColor: "#00aade",
      logo: null,
      invoicePrefix: "MM",
      companyName: "MeetingMinds Group LLC",
      companyAddress: "123 Business Bay",
      companyCity: "Dubai",
      companyState: null,
      companyZipCode: "00000",
      companyCountry: "UAE",
      companyPhone: "+971 4 123 4567",
      companyEmail: "billing@meetingminds.com",
      taxId: "TAX-123-456",
    },
  },
};

// ── Helper: set up transaction mock ──────────────────────────────────────────

function setupTxMock(onData?: (data: Record<string, unknown>) => void) {
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const txMock = {
      invoiceCounter: { upsert: vi.fn().mockResolvedValue({ lastSequence: 1 }) },
      invoice: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          onData?.(args.data);
          return { id: "inv-1", ...args.data };
        }),
      },
    };
    return cb(txMock);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createInvoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUniqueOrThrow.mockResolvedValue(fakeRegistration);
  });

  it("creates an invoice with SENT status", async () => {
    setupTxMock();
    const result = await createInvoice({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
    });
    expect(result.type).toBe("INVOICE");
    expect(result.status).toBe("SENT");
  });

  it("uses pricing tier price when available", async () => {
    mockFindUniqueOrThrow.mockResolvedValue({
      ...fakeRegistration,
      pricingTier: { name: "Early Bird", price: "75.00", currency: "EUR" },
    });

    let captured: Record<string, unknown> = {};
    setupTxMock((data) => { captured = data; });

    await createInvoice({ registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1" });

    expect(Number(captured.subtotal)).toBe(75);
    expect(captured.currency).toBe("EUR");
  });

  it("calculates tax correctly (100 * 5% = 5, total = 105)", async () => {
    let captured: Record<string, unknown> = {};
    setupTxMock((data) => { captured = data; });

    await createInvoice({ registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1" });

    expect(Number(captured.subtotal)).toBe(100);
    expect(Number(captured.taxAmount)).toBe(5);
    expect(Number(captured.total)).toBe(105);
    expect(Number(captured.taxRate)).toBe(5);
    expect(captured.taxLabel).toBe("VAT");
  });

  it("sets due date ~30 days from now by default", async () => {
    let captured: Record<string, unknown> = {};
    setupTxMock((data) => { captured = data; });

    await createInvoice({ registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1" });

    const dueDate = captured.dueDate as Date;
    const diffDays = Math.round((dueDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBeGreaterThanOrEqual(29);
    expect(diffDays).toBeLessThanOrEqual(30);
  });

  it("handles zero tax rate", async () => {
    mockFindUniqueOrThrow.mockResolvedValue({
      ...fakeRegistration,
      event: { ...fakeRegistration.event, taxRate: null },
    });

    let captured: Record<string, unknown> = {};
    setupTxMock((data) => { captured = data; });

    await createInvoice({ registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1" });

    expect(captured.taxRate).toBeNull();
    expect(Number(captured.taxAmount)).toBe(0);
    expect(Number(captured.total)).toBe(100);
  });

  it("throws when event has no code set", async () => {
    mockFindUniqueOrThrow.mockResolvedValue({
      ...fakeRegistration,
      event: { ...fakeRegistration.event, code: null },
    });

    await expect(
      createInvoice({ registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1" })
    ).rejects.toThrow("Event code is required");
  });
});

describe("createReceipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUniqueOrThrow.mockResolvedValue(fakeRegistration);
  });

  it("creates a receipt with PAID status", async () => {
    setupTxMock();
    const result = await createReceipt({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
      paymentId: "pay-1", paymentMethod: "stripe", paymentReference: "pi_123",
    });
    expect(result.type).toBe("RECEIPT");
    expect(result.status).toBe("PAID");
    expect(result.paymentMethod).toBe("stripe");
    expect(result.paymentReference).toBe("pi_123");
  });

  it("defaults paymentMethod to stripe", async () => {
    let captured: Record<string, unknown> = {};
    setupTxMock((data) => { captured = data; });

    await createReceipt({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
      paymentId: "pay-1",
    });

    expect(captured.paymentMethod).toBe("stripe");
  });
});

describe("createCreditNote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUniqueOrThrow.mockResolvedValue(fakeRegistration);
  });

  it("creates a credit note linked to original invoice", async () => {
    mockFindFirst.mockResolvedValue({ id: "inv-original" });

    let captured: Record<string, unknown> = {};
    setupTxMock((data) => { captured = data; });

    const result = await createCreditNote({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
      reason: "Customer requested refund",
    });

    expect(result.type).toBe("CREDIT_NOTE");
    expect(result.status).toBe("REFUNDED");
    expect(captured.parentInvoiceId).toBe("inv-original");
    expect(captured.notes).toBe("Customer requested refund");
  });

  it("creates credit note without parent when no invoice exists", async () => {
    mockFindFirst.mockResolvedValue(null);

    let captured: Record<string, unknown> = {};
    setupTxMock((data) => { captured = data; });

    await createCreditNote({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
    });

    expect(captured.parentInvoiceId).toBeUndefined();
    expect(captured.notes).toBe("Full refund");
  });
});

describe("cancelInvoice", () => {
  it("sets status to CANCELLED", async () => {
    mockUpdate.mockResolvedValue({ id: "inv-1", status: "CANCELLED" });

    const result = await cancelInvoice("inv-1");

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: { status: "CANCELLED" },
    });
    expect(result.status).toBe("CANCELLED");
  });
});
