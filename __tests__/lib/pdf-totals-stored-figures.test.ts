/**
 * drawTotals — stored figures win over recomputation (review M10).
 *
 * createCreditNote reconciles the tax component so a partial credit note's
 * pieces sum EXACTLY to the credited amount; the PDF layer used to throw
 * that away and re-derive tax from taxRate, drifting a cent from the DB
 * total (the number in the refund cap, the audit row, and the dialog the
 * organizer confirmed). These pin: overrides printed when provided, the
 * old recompute preserved when absent (quotes have no stored row).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { drawTotals, type TotalsInput } from "@/lib/pdf/document-layout";

/** Minimal chainable PDFKit stand-in that records every text() call. */
function fakeDoc() {
  const texts: string[] = [];
  const chain: Record<string, unknown> = {};
  const record = (t: unknown) => {
    texts.push(String(t));
    return chain;
  };
  Object.assign(chain, {
    page: { width: 595 },
    fontSize: () => chain,
    fillColor: () => chain,
    font: () => chain,
    text: record,
    lineWidth: () => chain,
    strokeColor: () => chain,
    moveTo: () => chain,
    lineTo: () => chain,
    stroke: () => chain,
    rect: () => chain,
    fill: () => chain,
  });
  return { doc: chain as unknown as PDFKit.PDFDocument, texts };
}

const base: TotalsInput = {
  currency: "USD",
  subtotal: 47.62,
  discountAmount: 0,
  discountLabel: null,
  taxRate: 5,
  taxLabel: "VAT",
};

describe("drawTotals (M10)", () => {
  it("prints the STORED taxAmount + total when overrides are provided", async () => {
    const { doc, texts } = fakeDoc();
    // Recompute would give 2.381 → "2.38" and 50.00…; the stored, reconciled
    // row says 2.38 tax / 50.01 total (partial-CN reconciliation artifact).
    drawTotals(doc, 100, { ...base, taxAmountOverride: 2.39, grandTotalOverride: 50.01 });
    expect(texts).toContain("2.39");
    expect(texts).toContain("50.01");
    expect(texts).not.toContain("50.00");
  });

  it("falls back to recomputing when no stored figures exist (quote PDFs)", async () => {
    const { doc, texts } = fakeDoc();
    drawTotals(doc, 100, { ...base, subtotal: 100, taxRate: 5 });
    expect(texts).toContain("5.00");   // 100 × 5%
    expect(texts).toContain("105.00");
  });
});
