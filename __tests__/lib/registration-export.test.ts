/**
 * Unit tests for the registrations CSV row builder.
 *
 * The export moved from the browser to the server so it could be audited. The
 * risk in that move is a *silent* change to the file operators already rely on,
 * so these tests pin:
 *   - header/row arity (a column added to one and not the other shifts every
 *     downstream spreadsheet by one),
 *   - the money rules (VAT via the shared helper; cancelled/settled owe 0),
 *   - and the redaction contract: a caller whose role had finance or barcode
 *     fields stripped gets BLANK cells, never a wrong number and never a
 *     different column count.
 */

import { describe, it, expect } from "vitest";
import {
  REGISTRATION_EXPORT_HEADERS,
  buildRegistrationExportRow,
  type RegistrationExportRow,
} from "@/lib/registration-export";

const ctx = { taxRate: 5, taxLabel: "VAT" };

function row(overrides: Partial<RegistrationExportRow> = {}): RegistrationExportRow {
  return {
    id: "reg_1",
    serialId: 7,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: new Date("2026-03-15T08:00:00Z"),
    checkedInAt: null,
    dtcmBarcode: "DTCM-123",
    discountAmount: 0,
    originalPrice: 100,
    utmSource: "linkedin",
    utmMedium: "social",
    utmCampaign: "spring",
    referrer: "https://example.com",
    attendee: {
      title: "Dr",
      role: "PHYSICIAN",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      organization: "Tawam",
      jobTitle: "Consultant",
      phone: "+97150",
      city: "Dubai",
      country: "UAE",
      bio: "",
      specialty: "Cardiology",
      tags: ["vip", "committee"],
      registrationType: "Physician",
    },
    ticketType: { id: "tt_1", name: "Physician", isFaculty: false, currency: "USD", price: 100 },
    pricingTier: null,
    billingAccount: { name: "Cleveland Clinic" },
    promoCode: { code: "EARLY10" },
    payments: [{ status: "PAID", amount: 40 }],
    ...overrides,
  };
}

const col = (r: string[], name: (typeof REGISTRATION_EXPORT_HEADERS)[number]) =>
  r[REGISTRATION_EXPORT_HEADERS.indexOf(name)];

describe("buildRegistrationExportRow", () => {
  it("produces exactly one cell per header", () => {
    expect(buildRegistrationExportRow(row(), ctx)).toHaveLength(REGISTRATION_EXPORT_HEADERS.length);
  });

  it("renders identity + attribution columns", () => {
    const r = buildRegistrationExportRow(row(), ctx);
    expect(col(r, "Registration ID")).toBe("reg_1");
    expect(col(r, "First Name")).toBe("Jane");
    expect(col(r, "Email")).toBe("jane@example.com");
    expect(col(r, "Tags")).toBe("vip, committee");
    expect(col(r, "Source")).toBe("linkedin");
    expect(col(r, "Campaign")).toBe("spring");
  });

  it("computes amount due through the shared financials helper (100 + 5% VAT − 40 paid)", () => {
    const r = buildRegistrationExportRow(row(), ctx);
    expect(col(r, "Total Paid")).toBe("40.00");
    expect(col(r, "Amount Due")).toBe("65.00"); // 105 total − 40 paid
  });

  it("owes nothing once CANCELLED, even with an outstanding balance", () => {
    const r = buildRegistrationExportRow(row({ status: "CANCELLED" }), ctx);
    expect(col(r, "Amount Due")).toBe("0.00");
  });

  it("owes nothing on a settled payment status", () => {
    const r = buildRegistrationExportRow(row({ paymentStatus: "COMPLIMENTARY" }), ctx);
    expect(col(r, "Amount Due")).toBe("0.00");
  });

  it("prices from the pricing tier when one is set", () => {
    const r = buildRegistrationExportRow(
      row({ originalPrice: null, pricingTier: { name: "Early Bird", currency: "USD", price: 400 }, payments: [] }),
      { taxRate: 0, taxLabel: null },
    );
    expect(col(r, "Pricing Tier")).toBe("Early Bird");
    expect(col(r, "Amount Due")).toBe("400.00");
  });

  // ── The redaction contract ───────────────────────────────────────────────
  // redactFinancialFields DELETES keys rather than zeroing them, so an absent
  // `payments` means "this role can't see money" — not "nothing was paid".
  it("blanks money columns (not 0.00) when finance fields were redacted", () => {
    const redacted = row();
    delete (redacted as Partial<RegistrationExportRow>).payments;
    delete (redacted as Partial<RegistrationExportRow>).billingAccount;

    const r = buildRegistrationExportRow(redacted, ctx);
    expect(col(r, "Amount Due")).toBe("");
    expect(col(r, "Total Paid")).toBe("");
    expect(col(r, "Discount")).toBe("");
    expect(col(r, "Payer")).toBe("");
    // …but the column count is unchanged, so the file still parses.
    expect(r).toHaveLength(REGISTRATION_EXPORT_HEADERS.length);
  });

  it("blanks the DTCM barcode when the caller may not hold a door credential", () => {
    const redacted = row();
    delete (redacted as Partial<RegistrationExportRow>).dtcmBarcode;
    const r = buildRegistrationExportRow(redacted, ctx);
    expect(col(r, "DTCM Barcode")).toBe("");
    expect(r).toHaveLength(REGISTRATION_EXPORT_HEADERS.length);
  });

  it("distinguishes a genuinely unpaid registration from a redacted one", () => {
    const r = buildRegistrationExportRow(row({ payments: [] }), ctx);
    expect(col(r, "Total Paid")).toBe("0.00"); // visible, and genuinely zero
  });

  it("shows a faculty companion's profession, never the literal 'Faculty'", () => {
    const r = buildRegistrationExportRow(
      row({ ticketType: { id: "tt_f", name: "Faculty", isFaculty: true, currency: "USD", price: 0 } }),
      ctx,
    );
    expect(col(r, "Registration Type")).toBe("Physician");
  });

  it("tolerates a row with every optional field missing", () => {
    const minimal: RegistrationExportRow = {
      id: "reg_x",
      status: "PENDING",
      paymentStatus: "UNPAID",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      attendee: { firstName: "A", lastName: "B", email: "a@b.c" },
    };
    const r = buildRegistrationExportRow(minimal, { taxRate: null, taxLabel: null });
    expect(r).toHaveLength(REGISTRATION_EXPORT_HEADERS.length);
    expect(col(r, "Tags")).toBe("");
    expect(col(r, "Checked In Date")).toBe("");
  });
});
