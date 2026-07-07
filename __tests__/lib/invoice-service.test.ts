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
    // Backfill path writes `event.code` lazily when legacy events are
    // missing one. Stub resolves successfully so the fire-and-forget
    // .catch() at the call site never fires during the test.
    event: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
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

// The combined-documents sender delegates the actual email to the shared
// payment-confirmation module — spy on it here (its own behavior is covered in
// payment-confirmation-email.test.ts). Provide the constants invoice-service
// imports from it.
const mockSendPaymentConfirmationEmail = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/payment-confirmation-email", () => ({
  sendPaymentConfirmationEmail: mockSendPaymentConfirmationEmail,
  paymentConfirmationRegInclude: {},
  INVOICE_ACCOUNTING_BCC: [
    { email: "accounts@meetingmindsdubai.com" },
    { email: "accounts@meetingmindsexperts.com" },
  ],
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/utils", () => ({
  getTitleLabel: vi.fn((t: string) => t === "DR" ? "Dr." : ""),
  formatDate: vi.fn((d: Date) => d.toISOString().split("T")[0]),
  // Minimal stand-in for the real implementation. Enough for the tests
  // that check derived-code behavior — they only need "Production Test"
  // → "PRODUC" (first-word fallback) and "Test Conference" → "TC" (but
  // the latter falls below the 2-char initials threshold and hits the
  // first-word fallback of "TEST").
  deriveEventCode: vi.fn((name: string) => {
    const words = name.trim().split(/\s+/);
    if (words.length >= 2) {
      const initials = words.map((w) => /^\d+$/.test(w) ? w : w[0] ?? "").join("").toUpperCase();
      if (initials.length >= 2) return initials.slice(0, 10);
    }
    return (words[0] ?? "EVT").toUpperCase().slice(0, 6);
  }),
}));

import {
  createInvoice, createPaidInvoice, createPaidReceipt, createCreditNote,
  cancelInvoice, sendInvoiceEmail, issuePaidRegistrationDocuments,
} from "@/lib/invoice-service";
import { sendEmail } from "@/lib/email";

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
        // `createPaidInvoice` probes for an existing SENT/DRAFT/OVERDUE
        // invoice before minting a fresh one. Default to "none" so
        // callers exercise the create path unless they explicitly
        // override via `mockFindFirst.mockResolvedValueOnce(...)`.
        findFirst: mockFindFirst.mockResolvedValue(null),
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

  it("succeeds when event has no code set, deriving a fallback code from event.name", async () => {
    // Behavior change (April 2026): pre-fix this threw, which silently killed
    // the Stripe webhook's fire-and-forget invoice creation and led to users
    // getting `quote.json` downloads instead of invoices. Now we derive a
    // code from the event name and log a warn, letting the flow proceed.
    mockFindUniqueOrThrow.mockResolvedValue({
      ...fakeRegistration,
      event: { ...fakeRegistration.event, code: null, name: "Test Conference" },
    });
    setupTxMock();

    const result = await createInvoice({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
    });
    expect(result).toBeDefined();
    expect(result.type).toBe("INVOICE");
  });

  it("passes the derived event code through to getNextInvoiceNumber (not 'null' or empty)", async () => {
    const { getNextInvoiceNumber } = await import("@/lib/invoice-numbering");
    const getNextMock = vi.mocked(getNextInvoiceNumber);
    getNextMock.mockClear();

    mockFindUniqueOrThrow.mockResolvedValue({
      ...fakeRegistration,
      event: { ...fakeRegistration.event, code: null, name: "Production Test" },
    });
    setupTxMock();

    await createInvoice({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
    });

    // "Production Test" is a 2-word name → deriveEventCode collects word
    // initials → "PT". Matches the same derivation the REST POST
    // /api/events + MCP create_event use, so quote + invoice for the
    // same legacy event share one deterministic prefix.
    const lastCall = getNextMock.mock.calls[getNextMock.mock.calls.length - 1];
    expect(lastCall?.[3]).toBe("PT");
  });
});

describe("createPaidInvoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUniqueOrThrow.mockResolvedValue(fakeRegistration);
  });

  it("mints a fresh INVOICE with status PAID when no pre-existing invoice", async () => {
    mockFindFirst.mockResolvedValueOnce(null); // no existing SENT invoice
    setupTxMock();
    const result = await createPaidInvoice({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
      paymentId: "pay-1", paymentMethod: "stripe", paymentReference: "pi_123",
    });
    expect(result.type).toBe("INVOICE");
    expect(result.status).toBe("PAID");
    expect(result.paymentMethod).toBe("stripe");
    expect(result.paymentReference).toBe("pi_123");
  });

  it("defaults paymentMethod to stripe", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    let captured: Record<string, unknown> = {};
    setupTxMock((data) => { captured = data; });

    await createPaidInvoice({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
      paymentId: "pay-1",
    });

    expect(captured.paymentMethod).toBe("stripe");
    expect(captured.type).toBe("INVOICE");
    expect(captured.status).toBe("PAID");
  });

  it("promotes an existing SENT invoice in place rather than duplicating", async () => {
    // A pre-existing admin-created INVOICE exists → we update it to PAID
    // instead of minting a second row with a fresh invoice number.
    mockFindFirst.mockResolvedValueOnce({ id: "inv-existing", invoiceNumber: "INV-2026-0001" });
    mockUpdate.mockResolvedValueOnce({
      id: "inv-existing",
      type: "INVOICE",
      status: "PAID",
      invoiceNumber: "INV-2026-0001",
      paymentMethod: "stripe",
    });
    // Swap tx to route through update, not create
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      return fn({
        invoice: {
          findFirst: mockFindFirst,
          create: mockCreate,
          update: mockUpdate,
          updateMany: mockUpdateMany,
        },
      });
    });

    const result = await createPaidInvoice({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
      paymentId: "pay-1",
    });

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "inv-existing" },
      data: expect.objectContaining({ status: "PAID", paymentId: "pay-1" }),
    }));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.invoiceNumber).toBe("INV-2026-0001");
  });
});

describe("createPaidInvoice — idempotency for an already-PAID invoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUniqueOrThrow.mockResolvedValue(fakeRegistration);
  });

  it("returns the existing PAID invoice untouched (no duplicate, no update)", async () => {
    // Webhook retry / reconciliation re-run: an INVOICE is already PAID.
    mockFindFirst.mockResolvedValueOnce({ id: "inv-paid", invoiceNumber: "INV-2026-0001", status: "PAID" });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ invoice: { findFirst: mockFindFirst, create: mockCreate, update: mockUpdate, updateMany: mockUpdateMany } }),
    );

    const result = await createPaidInvoice({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1", paymentId: "pay-1",
    });

    expect(result.id).toBe("inv-paid");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe("createPaidReceipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUniqueOrThrow.mockResolvedValue(fakeRegistration);
  });

  it("mints a RECEIPT (status PAID) linked to the paid invoice via parentInvoiceId", async () => {
    mockFindFirst.mockResolvedValueOnce(null); // no existing receipt
    let captured: Record<string, unknown> = {};
    setupTxMock((data) => { captured = data; });

    const result = await createPaidReceipt({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
      paymentId: "pay-1", parentInvoiceId: "inv-1", paymentMethod: "stripe", paymentReference: "pi_123",
    });

    expect(result.created).toBe(true);
    expect(captured.type).toBe("RECEIPT");
    expect(captured.status).toBe("PAID");
    expect(captured.parentInvoiceId).toBe("inv-1");
    expect(captured.paymentMethod).toBe("stripe");
    expect(captured.paymentReference).toBe("pi_123");
    // Same pricing as the invoice (100 + 5% VAT).
    expect(Number(captured.subtotal)).toBe(100);
    expect(Number(captured.taxAmount)).toBe(5);
    expect(Number(captured.total)).toBe(105);
  });

  it("is idempotent — returns the existing receipt without creating a duplicate", async () => {
    mockFindFirst.mockResolvedValueOnce({ id: "rec-existing", invoiceNumber: "REC-1", type: "RECEIPT" });
    let created = false;
    setupTxMock(() => { created = true; });

    const result = await createPaidReceipt({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1", paymentId: "pay-1",
    });

    expect(result.created).toBe(false);
    expect(result.receipt.id).toBe("rec-existing");
    expect(created).toBe(false); // no transaction → no second RECEIPT row
    expect(mockFindUniqueOrThrow).not.toHaveBeenCalled(); // short-circuits before loading the registration
  });
});

describe("issuePaidRegistrationDocuments — invoice + receipt + one combined email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUniqueOrThrow.mockResolvedValue(fakeRegistration);
    mockUpdateMany.mockResolvedValue({ count: 2 });
  });

  it("creates the invoice + receipt and sends ONE email carrying BOTH PDFs", async () => {
    const { db } = await import("@/lib/db");
    // createPaidInvoice + createPaidReceipt both mint (no existing docs).
    mockFindFirst.mockResolvedValue(null);
    setupTxMock(); // tx create returns { id: "inv-1", ... }

    // generatePDFForInvoice loads each doc by id; return an INVOICE then a RECEIPT.
    const pdfReg = { ...fakeRegistration };
    (db.invoice.findUniqueOrThrow as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ type: "INVOICE", invoiceNumber: "HFC2026-INV-001", subtotal: 100, currency: "USD", taxRate: 5, taxLabel: "VAT", discountCode: null, discountAmount: 0, issueDate: new Date(), dueDate: new Date(), status: "PAID", paidDate: new Date(), paymentMethod: "stripe", paymentReference: "pi_1", parentInvoice: null, payment: null, registration: pdfReg })
      .mockResolvedValueOnce({ type: "RECEIPT", invoiceNumber: "HFC2026-REC-001", subtotal: 100, currency: "USD", taxRate: 5, taxLabel: "VAT", discountCode: null, discountAmount: 0, issueDate: new Date(), paidDate: new Date(), paymentMethod: "stripe", paymentReference: "pi_1", registration: pdfReg });

    const result = await issuePaidRegistrationDocuments({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
      paymentId: "pay-1", paymentMethod: "card", paymentReference: "pi_1",
      amount: 105, currency: "USD", receiptUrl: "https://stripe.test/r/1",
    });

    expect(result.invoice).toBeDefined();
    expect(result.receipt).toBeDefined();

    // The single combined email got BOTH attachments + the amount/receipt link.
    expect(mockSendPaymentConfirmationEmail).toHaveBeenCalledTimes(1);
    const [, amount, currency, receiptUrl, , attachments] = mockSendPaymentConfirmationEmail.mock.calls[0];
    expect(amount).toBe(105);
    expect(currency).toBe("USD");
    expect(receiptUrl).toBe("https://stripe.test/r/1");
    expect(attachments).toHaveLength(2);
    // Two PDF attachments (invoice + receipt); names come from each doc's number.
    expect(attachments.every((a: { name: string; contentType: string }) => a.name.endsWith(".pdf") && a.contentType === "application/pdf")).toBe(true);
    // Both documents marked as sent.
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ sentTo: "john@example.com" }),
    }));
  });
});

describe("createCreditNote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUniqueOrThrow.mockResolvedValue(fakeRegistration);
  });

  // createCreditNote now queries invoice.findFirst twice: (1) the CREDIT_NOTE
  // idempotency check, (2) the parent INVOICE lookup. Route by `where.type`.
  function stubFindFirst({ existingCreditNote = null as unknown, parentInvoice = null as unknown } = {}) {
    mockFindFirst.mockImplementation((args: { where: { type: string } }) =>
      Promise.resolve(args.where.type === "CREDIT_NOTE" ? existingCreditNote : parentInvoice),
    );
  }

  it("creates a credit note linked to original invoice", async () => {
    stubFindFirst({ parentInvoice: { id: "inv-original" } });

    let captured: Record<string, unknown> = {};
    setupTxMock((data) => { captured = data; });

    const result = await createCreditNote({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
      reason: "Customer requested refund",
    });

    expect(result.created).toBe(true);
    expect(result.invoice.type).toBe("CREDIT_NOTE");
    expect(result.invoice.status).toBe("REFUNDED");
    expect(captured.parentInvoiceId).toBe("inv-original");
    expect(captured.notes).toBe("Customer requested refund");
  });

  it("creates credit note without parent when no invoice exists", async () => {
    stubFindFirst();

    let captured: Record<string, unknown> = {};
    setupTxMock((data) => { captured = data; });

    const result = await createCreditNote({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
    });

    expect(result.created).toBe(true);
    expect(captured.parentInvoiceId).toBeUndefined();
    expect(captured.notes).toBe("Full refund");
  });

  it("is idempotent — returns the existing credit note without creating a duplicate", async () => {
    stubFindFirst({ existingCreditNote: { id: "cn-existing", invoiceNumber: "CN-1", type: "CREDIT_NOTE" } });

    let created = false;
    setupTxMock(() => { created = true; });

    const result = await createCreditNote({
      registrationId: "reg-1", eventId: "evt-1", organizationId: "org-1",
    });

    expect(result.created).toBe(false);
    expect(result.invoice.id).toBe("cn-existing");
    expect(created).toBe(false); // no transaction → no second CREDIT_NOTE row
    expect(mockFindUniqueOrThrow).not.toHaveBeenCalled(); // short-circuits before loading the registration
  });
});

describe("cancelInvoice", () => {
  it("sets status to CANCELLED", async () => {
    const { db } = await import("@/lib/db");
    (db.invoice.findUniqueOrThrow as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: "inv-1", status: "DRAFT", invoiceNumber: "INV-1" });
    mockUpdate.mockResolvedValue({ id: "inv-1", status: "CANCELLED" });

    const result = await cancelInvoice("inv-1");

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: { status: "CANCELLED" },
    });
    expect(result.status).toBe("CANCELLED");
  });
});

describe("sendInvoiceEmail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("BCCs the accounting inboxes on every invoice email", async () => {
    const { db } = await import("@/lib/db");
    (db.invoice.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "inv-1", type: "INVOICE", invoiceNumber: "INV-1",
      organizationId: "org-1", eventId: "evt-1", registrationId: "reg-1",
      subtotal: 100, discountAmount: 0, discountCode: null, taxRate: 5,
      taxLabel: "VAT", taxAmount: 5, total: 105, currency: "USD",
      issueDate: new Date("2026-07-07"), paidDate: null, paymentMethod: null, paymentReference: null, notes: null,
      parentInvoice: null, payment: null,
      registration: { ...fakeRegistration, event: { ...fakeRegistration.event, emailFromAddress: null, emailFromName: null } },
    });
    mockUpdate.mockResolvedValue({});

    await sendInvoiceEmail("inv-1");

    const call = (sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const bccEmails = (call.bcc as { email: string }[]).map((b) => b.email);
    expect(bccEmails).toEqual(
      expect.arrayContaining(["accounts@meetingmindsdubai.com", "accounts@meetingmindsexperts.com"]),
    );
    // attendee is still the primary recipient (accounting is BCC, not visible)
    expect(call.to[0].email).toBe("john@example.com");
  });
});
