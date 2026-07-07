/**
 * Pins the invoice-export formatters — most importantly the CSV
 * formula-injection guard (H1): attendee names / org / billing address flow
 * into the finance CSV + QuickBooks CSV and are attacker-controllable via
 * public self-registration, so a leading = + - @ (or tab / CR) must be
 * neutralized before finance opens the file in Excel / QuickBooks.
 */
import { describe, it, expect } from "vitest";
import {
  csvCell,
  buildInvoiceCsv,
  buildInvoiceQuickBooksCsv,
  type InvoiceExportRow,
} from "@/lib/invoice-export";

function row(overrides: Partial<InvoiceExportRow> = {}): InvoiceExportRow {
  return {
    invoiceNumber: "INV-001",
    type: "INVOICE",
    status: "PAID",
    issueDate: new Date("2026-01-29T00:00:00Z"),
    dueDate: null,
    paidDate: null,
    subtotal: 100,
    discountAmount: 0,
    taxRate: 5,
    taxAmount: 5,
    total: 105,
    currency: "USD",
    event: { name: "Conference 2026", city: "Dubai" },
    registration: {
      billingAddress: null,
      ticketType: { name: "Physician" },
      pricingTier: { name: "Early Bird" },
      attendee: { title: "Dr", firstName: "Jane", lastName: "Doe", email: "jane@x.test" },
    },
    ...overrides,
  };
}

describe("csvCell — formula-injection guard", () => {
  it("prefixes a quote to values starting with a formula trigger", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+A1")).toBe("'+A1");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tfoo")).toBe("'\tfoo");
  });

  it("leaves ordinary values untouched (and still quotes commas/quotes/newlines)", () => {
    expect(csvCell("Physician")).toBe("Physician");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe("");
    expect(csvCell(105)).toBe("105");
  });

  it("still neutralizes AND quotes a formula that also contains a comma", () => {
    // Prefixed with ' then quoted because of the comma.
    expect(csvCell("=HYPERLINK(1,2)")).toBe('"\'=HYPERLINK(1,2)"');
  });
});

describe("buildInvoiceCsv / buildInvoiceQuickBooksCsv — injection neutralized end-to-end", () => {
  const evil = row({
    registration: {
      billingAddress: "=cmd|'/c calc'!A1",
      ticketType: { name: "Physician" },
      pricingTier: { name: "Early Bird" },
      attendee: { title: null, firstName: "=HYPERLINK(\"http://evil\")", lastName: "Doe", email: "e@x.test" },
    },
  });

  it("plain CSV neutralizes a formula-injected bill-to name", () => {
    const csv = buildInvoiceCsv([evil]);
    expect(csv).toContain("'=HYPERLINK");        // name is prefixed
    expect(csv).not.toMatch(/,=HYPERLINK/);      // never a bare leading =
  });

  it("QuickBooks CSV neutralizes a formula-injected billing address + customer", () => {
    const csv = buildInvoiceQuickBooksCsv([evil]);
    expect(csv).toContain("'=cmd");              // billing address prefixed
    expect(csv).toContain("'=HYPERLINK");        // customer prefixed
    expect(csv).not.toMatch(/,=cmd/);
  });

  it("QuickBooks LineDesc combines ticket type + pricing tier", () => {
    expect(buildInvoiceQuickBooksCsv([row()])).toContain("Physician - Early Bird");
  });

  it("QuickBooks LineUnitPrice is net of discount so unitPrice + tax = LineAmount (review L4)", () => {
    // subtotal 100, discount 10, VAT 5% → net 90, total 94.50.
    const csv = buildInvoiceQuickBooksCsv([
      row({ subtotal: 100, discountAmount: 10, taxRate: 5, taxAmount: 4.5, total: 94.5 }),
    ]);
    const cols = csv.split("\r\n")[1].split(",");
    expect(cols[7]).toBe("90.00");  // LineUnitPrice = subtotal − discount
    expect(cols[12]).toBe("94.50"); // LineAmount = total (gross)
    // Reconciles: 90.00 × 1.05 = 94.50
  });

  it("undiscounted invoice still maps LineUnitPrice = subtotal (unchanged)", () => {
    const cols = buildInvoiceQuickBooksCsv([row()]).split("\r\n")[1].split(",");
    expect(cols[7]).toBe("100.00");
    expect(cols[12]).toBe("105.00");
  });
});
