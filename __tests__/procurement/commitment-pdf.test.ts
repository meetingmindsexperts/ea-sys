/** The purchase order renders through the shared document layout: a real PDF comes out of a sample, and a line's text says what it should. */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { generatePurchaseOrderPdf, orderLineText } from "@/procurement/lib/commitment-pdf";

const sample = {
  commitmentNo: "PO-2026-0003",
  issuedAt: new Date("2026-09-15T08:00:00Z"),
  eventName: "Hematology Summit 2026",
  eventCode: "HM2026",
  requestNo: "PR-2026-0007",
  requesterName: "Dev Admin",
  currency: "AED",
  amount: "36000.0000",
  taxAmount: "1800.0000",
  lines: [{ description: "LED wall for the plenary hall", qty: "1.0000", unitCost: "36000.0000", amount: "36000.0000", taxRatePercent: "5", taxCode: null }],
  supplier: { code: "GULFAV", displayName: "Gulf AV", legalName: "Gulf Audio Visual LLC", country: "AE", paymentTerms: "30 days", contactName: "Sara", contactEmail: "sara@example.test" },
  company: { name: "MM Group", companyName: "Meeting Minds FZ LLC", address: "508 & 509, DSC tower", city: "Dubai", state: null, zipCode: null, country: "UAE", phone: null, email: null, taxId: "100123456700003", logoPath: null },
};

describe("generatePurchaseOrderPdf", () => {
  it("produces a PDF from a sample order, with the totals and notes laid out", async () => {
    const pdf = await generatePurchaseOrderPdf(sample);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1500);
  });
  it("renders an order with no tax and a multi-line body too", async () => {
    const pdf = await generatePurchaseOrderPdf({
      ...sample,
      taxAmount: "0.0000",
      lines: [
        { description: "Stage", qty: "2.0000", unitCost: "1000.0000", amount: "2000.0000", taxRatePercent: null, taxCode: null },
        { description: "Rigging", qty: "1.0000", unitCost: "500.0000", amount: "500.0000", taxRatePercent: null, taxCode: "ZR" },
      ],
      amount: "2500.0000",
    });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("orderLineText", () => {
  it("shows the quantity and unit cost only when the line is not a single unit, and the tax code or rate", () => {
    expect(orderLineText({ description: "LED wall", qty: "1", unitCost: "36000", amount: "36000", taxRatePercent: "5", taxCode: null })).toBe("LED wall · VAT 5%");
    expect(orderLineText({ description: "Stage", qty: "2", unitCost: "1000", amount: "2000", taxRatePercent: null, taxCode: null })).toBe("Stage · 2 × 1000.00");
    expect(orderLineText({ description: "Rigging", qty: "1", unitCost: "500", amount: "500", taxRatePercent: "5", taxCode: "ZR" })).toBe("Rigging · ZR");
  });
});
