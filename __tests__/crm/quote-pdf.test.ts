/**
 * CRM quote PDF: the structure of the owner's sample quote.
 *
 * pdfkit compresses content streams and subsets fonts, so the words on a page
 * cannot be found in the output bytes. The tests spy on
 * PDFDocument.prototype.text with call-through instead: pdfkit still renders
 * for real, and what was written to the page is observable.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import PDFDocument from "pdfkit";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { renderQuotePdf, type QuotePdfInput } from "@/crm/lib/quote-pdf";
import { QUOTE_DIGITAL_NOTE } from "@/crm/lib/quote-rules";

const base: QuotePdfInput = {
  company: {
    name: "Meeting Minds - FZ LLC",
    addressLines: ["Dubai Studio City 508/509", "Dubai 502464"],
    taxId: "100352048100003",
    logoBuffer: null,
  },
  number: "Q-2026-0003",
  title: "Abbott Quote - MEHFC 2026",
  currency: "USD",
  quoteDate: "2026-09-15",
  validUntil: "2026-10-15",
  preparedByName: "Atiqur Rahman",
  preparedFor: "Abbott",
  attention: "Sara Khan",
  locationLine: "Dubai, UAE",
  eventName: "Middle East Heart Failure Conference 2026",
  lines: [
    {
      productCode: "SPO10001",
      name: "Sponsorship - Diamond",
      description: "Diamond tier benefits",
      quantity: 1,
      unitPrice: 95000,
      amount: 95000,
    },
  ],
  subtotal: 95000,
  taxRate: 5,
  taxLabel: "VAT",
  taxAmount: 4750,
  total: 99750,
  terms: "This quotation is subject to 5% VAT.",
  notes: null,
  generatedAt: new Date("2026-09-15T08:00:00.000Z"),
};

afterEach(() => {
  vi.restoreAllMocks();
});

function writtenText(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

describe("renderQuotePdf", () => {
  it("produces a PDF", async () => {
    const pdf = await renderQuotePdf(base);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("prints every part of the sample: title box, prepared for, quote number, validity, the product table, totals, terms and the signature note", async () => {
    const spy = vi.spyOn(PDFDocument.prototype, "text");
    await renderQuotePdf(base);
    const text = writtenText(spy);

    for (const expected of [
      "QUOTATION / ESTIMATE",
      "Abbott Quote - MEHFC 2026",
      "Date: 15/09/2026",
      "Q-2026-0003",
      "15/10/2026",
      "Atiqur Rahman",
      "Attn: Sara Khan",
      "Product code",
      "Product name",
      "Quantity",
      "Unit price",
      "Total price",
      "SPO10001",
      "Sponsorship - Diamond",
      "Diamond tier benefits",
      "95,000.00 USD",
      "VAT (5%)",
      "4,750.00 USD",
      "99,750.00 USD",
      "Terms and Conditions",
      "This quotation is subject to 5% VAT.",
      QUOTE_DIGITAL_NOTE,
    ]) {
      expect(text, `missing "${expected}"`).toContain(expected);
    }
    expect(text.some((t) => t.includes("Abbott"))).toBe(true);
  });

  it("omits the tax row when no tax applies, and the terms and notes when empty", async () => {
    const spy = vi.spyOn(PDFDocument.prototype, "text");
    await renderQuotePdf({ ...base, taxRate: null, taxAmount: 0, total: 95000, terms: null, notes: "  " });
    const text = writtenText(spy);

    expect(text.some((t) => t.startsWith("VAT ("))).toBe(false);
    expect(text).not.toContain("Terms and Conditions");
    expect(text).not.toContain("Notes");
  });

  it("breaks a long quote across pages and repeats the table header on each", async () => {
    const spy = vi.spyOn(PDFDocument.prototype, "text");
    const addPage = vi.spyOn(PDFDocument.prototype, "addPage");
    const lines = Array.from({ length: 60 }, (_, i) => ({
      productCode: `SKU-${i}`,
      name: `Line item ${i}`,
      description: "A description long enough to wrap onto a second line in the product name column of the table.",
      quantity: 2,
      unitPrice: 1000,
      amount: 2000,
    }));

    const pdf = await renderQuotePdf({ ...base, lines, subtotal: 120000, taxAmount: 6000, total: 126000 });

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(addPage).toHaveBeenCalled();
    const headers = writtenText(spy).filter((t) => t === "Product code").length;
    expect(headers).toBeGreaterThanOrEqual(2);
  });
});
