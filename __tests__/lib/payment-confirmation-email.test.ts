/**
 * Unit tests for the shared payment-confirmation email sender. The key new
 * behavior finance asked for: when the invoice + receipt PDFs are passed as
 * attachments the payer gets ONE combined email carrying both, and accounting
 * is BCC'd. Without attachments (legacy shape) neither happens.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSendEmail } = vi.hoisted(() => ({ mockSendEmail: vi.fn().mockResolvedValue({ success: true }) }));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/utils", () => ({ getTitleLabel: vi.fn(() => "Dr.") }));
vi.mock("@/lib/registration-financials", () => ({
  readRegistrationBasePrice: vi.fn(() => 100),
  computeRegistrationFinancials: vi.fn(() => ({
    subtotal: 100, discount: 0, taxRate: 5, taxAmount: 5, taxLabel: "VAT", total: 105,
  })),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: mockSendEmail,
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue({ textContent: "text {{amount}}" }),
  renderAndWrap: vi.fn().mockReturnValue({ subject: "Payment received", htmlContent: "<p>{{receiptBlock}}</p>", textContent: "text" }),
  renderTemplatePlain: vi.fn().mockReturnValue("plain"),
  brandingFrom: vi.fn().mockReturnValue({ email: "from@test.com", name: "Event" }),
  brandingCc: vi.fn().mockReturnValue([]),
}));

import { sendPaymentConfirmationEmail } from "@/lib/payment-confirmation-email";

const registration = {
  id: "reg-1",
  serialId: 7,
  attendee: { firstName: "John", lastName: "Doe", email: "john@example.com", additionalEmail: null, title: "DR" },
  ticketType: { name: "Standard", price: "100.00", currency: "USD" },
  pricingTier: null,
  discountAmount: 0,
  event: {
    id: "evt-1", organizationId: "org-1", name: "Conf", slug: "conf",
    startDate: new Date("2026-06-01"), venue: "DWTC", city: "Dubai", taxRate: "5", taxLabel: "VAT",
  },
};

const invoicePdf = { name: "INV-001.pdf", content: "aW52", contentType: "application/pdf" };
const receiptPdf = { name: "REC-001.pdf", content: "cmVj", contentType: "application/pdf" };

beforeEach(() => vi.clearAllMocks());

describe("sendPaymentConfirmationEmail — combined documents packet", () => {
  it("attaches BOTH the invoice + receipt PDFs and BCCs accounting", async () => {
    await sendPaymentConfirmationEmail(registration, 105, "USD", "https://stripe.test/r/1", "pi_1", [invoicePdf, receiptPdf]);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const call = mockSendEmail.mock.calls[0][0];
    expect(call.to[0].email).toBe("john@example.com");
    expect(call.attachments).toHaveLength(2);
    expect(call.attachments.map((a: { name: string }) => a.name)).toEqual(["INV-001.pdf", "REC-001.pdf"]);
    const bcc = (call.bcc as { email: string }[]).map((b) => b.email);
    expect(bcc).toEqual(
      expect.arrayContaining(["accounts@meetingmindsdubai.com", "accounts@meetingmindsexperts.com"]),
    );
  });

  it("without attachments: no accounting BCC, no attachments (legacy shape)", async () => {
    await sendPaymentConfirmationEmail(registration, 105, "USD", null, null);

    const call = mockSendEmail.mock.calls[0][0];
    expect(call.bcc).toBeUndefined();
    expect(call.attachments).toBeUndefined();
  });
});
