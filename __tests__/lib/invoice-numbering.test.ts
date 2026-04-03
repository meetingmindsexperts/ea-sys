import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma
const mockUpsert = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    invoiceCounter: { upsert: mockUpsert },
  },
}));

import { getNextInvoiceNumber } from "@/lib/invoice-numbering";

describe("getNextInvoiceNumber", () => {
  const mockTx = {
    invoiceCounter: { upsert: mockUpsert },
  } as unknown as Parameters<typeof getNextInvoiceNumber>[0];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates INV-{year}-0001 for the first invoice", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 1 });

    const result = await getNextInvoiceNumber(mockTx, "org-1", "INVOICE");

    expect(result.sequenceNumber).toBe(1);
    expect(result.invoiceNumber).toMatch(/^INV-\d{4}-0001$/);
  });

  it("generates REC prefix for receipts", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 5 });

    const result = await getNextInvoiceNumber(mockTx, "org-1", "RECEIPT");

    expect(result.invoiceNumber).toMatch(/^REC-\d{4}-0005$/);
  });

  it("generates CN prefix for credit notes", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 3 });

    const result = await getNextInvoiceNumber(mockTx, "org-1", "CREDIT_NOTE");

    expect(result.invoiceNumber).toMatch(/^CN-\d{4}-0003$/);
  });

  it("uses custom prefix when provided for invoices", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 42 });

    const result = await getNextInvoiceNumber(mockTx, "org-1", "INVOICE", "EA");

    expect(result.invoiceNumber).toMatch(/^EA-\d{4}-0042$/);
  });

  it("ignores custom prefix for receipts (always REC)", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 1 });

    const result = await getNextInvoiceNumber(mockTx, "org-1", "RECEIPT", "CUSTOM");

    expect(result.invoiceNumber).toMatch(/^REC-/);
  });

  it("zero-pads sequence numbers to 4 digits", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 7 });

    const result = await getNextInvoiceNumber(mockTx, "org-1", "INVOICE");

    expect(result.invoiceNumber).toContain("-0007");
  });

  it("handles sequence numbers above 9999", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 12345 });

    const result = await getNextInvoiceNumber(mockTx, "org-1", "INVOICE");

    expect(result.invoiceNumber).toContain("-12345");
    expect(result.sequenceNumber).toBe(12345);
  });

  it("calls upsert with correct parameters", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 1 });
    const year = new Date().getFullYear();

    await getNextInvoiceNumber(mockTx, "org-abc", "INVOICE");

    expect(mockUpsert).toHaveBeenCalledWith({
      where: {
        organizationId_type_year: {
          organizationId: "org-abc",
          type: "INVOICE",
          year,
        },
      },
      create: { organizationId: "org-abc", type: "INVOICE", year, lastSequence: 1 },
      update: { lastSequence: { increment: 1 } },
    });
  });

  it("includes current year in invoice number", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 1 });
    const year = new Date().getFullYear();

    const result = await getNextInvoiceNumber(mockTx, "org-1", "INVOICE");

    expect(result.invoiceNumber).toBe(`INV-${year}-0001`);
  });
});
