/**
 * canViewFinance() is the single finance-visibility boundary; the agent
 * redaction pass, the denyFinance guard, and API field-stripping all derive
 * from it. As of June 17, 2026 MEMBER + ONSITE are registration-desk operators
 * who record payments, so they SEE money; only REVIEWER/SUBMITTER/REGISTRANT
 * (and unknown roles) are denied. The redaction-logic tests below are
 * role-agnostic — they pin that `paymentStatus` survives while amounts /
 * invoices / billing are stripped, whenever redaction IS applied.
 */
import { describe, it, expect } from "vitest";
import {
  canViewFinance,
  redactFinancialFields,
  FINANCE_ONLY_AGENT_TOOLS,
} from "@/lib/finance-visibility";

describe("canViewFinance", () => {
  it("permits SUPER_ADMIN / ADMIN / ORGANIZER and the desk operators MEMBER / ONSITE", () => {
    expect(canViewFinance("SUPER_ADMIN")).toBe(true);
    expect(canViewFinance("ADMIN")).toBe(true);
    expect(canViewFinance("ORGANIZER")).toBe(true);
    expect(canViewFinance("MEMBER")).toBe(true);
    expect(canViewFinance("ONSITE")).toBe(true);
  });

  it("denies the abstract/attendee roles", () => {
    expect(canViewFinance("REVIEWER")).toBe(false);
    expect(canViewFinance("SUBMITTER")).toBe(false);
    expect(canViewFinance("REGISTRANT")).toBe(false);
  });

  it("fails closed for null / undefined / unknown", () => {
    expect(canViewFinance(null)).toBe(false);
    expect(canViewFinance(undefined)).toBe(false);
    expect(canViewFinance("WIZARD")).toBe(false);
    expect(canViewFinance("")).toBe(false);
  });
});

describe("redactFinancialFields", () => {
  it("strips money / invoice / billing keys but keeps paymentStatus", () => {
    const reg = {
      id: "reg-1",
      status: "CONFIRMED",
      paymentStatus: "PAID", // operational — must survive
      attendee: { firstName: "Amani", email: "a@x.test" },
      amount: 500,
      totalPaid: 500,
      balanceDue: 0,
      taxRate: 5,
      bankDetails: "IBAN …",
      billingEmail: "billing@x.test",
      payments: [{ id: "p1", amount: 500, cardLast4: "4242" }],
      invoices: [{ id: "inv1", invoiceNumber: "HFF-INV-001" }],
      ticketType: { name: "Standard", price: 500 },
      pricingTier: { name: "Early Bird", price: 400 },
      // "Charge to another account" — the payer (with taxNumber), the
      // PO/grant ref, and the guarantor flag are Mecomed-sensitive
      // billing context. MEMBER must not see them.
      billingAccountId: "ba-1",
      billingAccount: { name: "Pfizer MENA", taxNumber: "TRN-9" },
      payerReference: "PO-12345",
      attendeeIsGuarantor: true,
    };
    const out = redactFinancialFields(reg) as Record<string, unknown>;

    // Kept
    expect(out.id).toBe("reg-1");
    expect(out.status).toBe("CONFIRMED");
    expect(out.paymentStatus).toBe("PAID");
    expect((out.attendee as Record<string, unknown>).firstName).toBe("Amani");
    expect((out.ticketType as Record<string, unknown>).name).toBe("Standard");
    expect((out.pricingTier as Record<string, unknown>).name).toBe("Early Bird");

    // Stripped
    expect(out.amount).toBeUndefined();
    expect(out.totalPaid).toBeUndefined();
    expect(out.balanceDue).toBeUndefined();
    expect(out.taxRate).toBeUndefined();
    expect(out.bankDetails).toBeUndefined();
    expect(out.billingEmail).toBeUndefined();
    expect(out.payments).toBeUndefined();
    expect(out.invoices).toBeUndefined();
    expect((out.ticketType as Record<string, unknown>).price).toBeUndefined();
    expect((out.pricingTier as Record<string, unknown>).price).toBeUndefined();
    expect(out.billingAccountId).toBeUndefined();
    expect(out.billingAccount).toBeUndefined();
    expect(out.payerReference).toBeUndefined();
    expect(out.attendeeIsGuarantor).toBeUndefined();
  });

  it("strips the whole computed `financials` block (MEMBER sees no money math)", () => {
    const reg = {
      id: "reg-1",
      status: "CONFIRMED",
      paymentStatus: "UNPAID",
      financials: {
        subtotal: 1000,
        taxAmount: 50,
        total: 1050,
        balanceDue: 1050,
        isPaidInFull: false,
      },
    };
    const out = redactFinancialFields(reg) as Record<string, unknown>;
    expect(out.id).toBe("reg-1");
    expect(out.paymentStatus).toBe("UNPAID"); // status label kept
    expect(out.financials).toBeUndefined(); // whole block gone
  });

  it("recurses through arrays of objects", () => {
    const list = [
      { id: 1, paymentStatus: "UNPAID", amount: 100 },
      { id: 2, paymentStatus: "PAID", amount: 200, payments: [{ amount: 200 }] },
    ];
    const out = redactFinancialFields(list) as Record<string, unknown>[];
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: 1, paymentStatus: "UNPAID" });
    expect(out[1]).toEqual({ id: 2, paymentStatus: "PAID" });
  });

  it("is non-destructive — original object untouched", () => {
    const original = { amount: 999, paymentStatus: "PAID" };
    redactFinancialFields(original);
    expect(original.amount).toBe(999);
  });

  it("passes primitives through unchanged", () => {
    expect(redactFinancialFields("hello")).toBe("hello");
    expect(redactFinancialFields(42)).toBe(42);
    expect(redactFinancialFields(null)).toBe(null);
    expect(redactFinancialFields(undefined)).toBe(undefined);
  });
});

describe("FINANCE_ONLY_AGENT_TOOLS", () => {
  it("lists the wholly-financial tools blocked for non-finance roles", () => {
    expect(FINANCE_ONLY_AGENT_TOOLS.has("list_invoices")).toBe(true);
    expect(FINANCE_ONLY_AGENT_TOOLS.has("list_unpaid_registrations")).toBe(true);
    // list_registrations is mixed (redacted, not blocked) — must NOT be here
    expect(FINANCE_ONLY_AGENT_TOOLS.has("list_registrations")).toBe(false);
  });
});
