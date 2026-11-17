import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma
const { mockUpsert } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { invoiceCounter: { upsert: mockUpsert } },
}));

import { getNextInvoiceNumber, formatQuoteNumber } from "@/lib/invoice-numbering";

describe("getNextInvoiceNumber", () => {
  const mockTx = {
    invoiceCounter: { upsert: mockUpsert },
  } as unknown as Parameters<typeof getNextInvoiceNumber>[0];

  beforeEach(() => vi.clearAllMocks());

  it("generates {eventCode}-INV-001 for the first invoice", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 1 });
    const result = await getNextInvoiceNumber(mockTx, "evt-1", "INVOICE", "HFC2026", "org-1");
    expect(result.sequenceNumber).toBe(1);
    expect(result.invoiceNumber).toBe("HFC2026-INV-001");
  });

  it("generates {eventCode}-REC-005 for receipts", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 5 });
    const result = await getNextInvoiceNumber(mockTx, "evt-1", "RECEIPT", "HFC2026", "org-1");
    expect(result.invoiceNumber).toBe("HFC2026-REC-005");
  });

  it("generates {eventCode}-CN-003 for credit notes", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 3 });
    const result = await getNextInvoiceNumber(mockTx, "evt-1", "CREDIT_NOTE", "HFC2026", "org-1");
    expect(result.invoiceNumber).toBe("HFC2026-CN-003");
  });

  it("zero-pads sequence to 3 digits", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 7 });
    const result = await getNextInvoiceNumber(mockTx, "evt-1", "INVOICE", "EVT", "org-1");
    expect(result.invoiceNumber).toBe("EVT-INV-007");
  });

  it("handles sequence numbers above 999", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 1234 });
    const result = await getNextInvoiceNumber(mockTx, "evt-1", "INVOICE", "ABC", "org-1");
    expect(result.invoiceNumber).toBe("ABC-INV-1234");
    expect(result.sequenceNumber).toBe(1234);
  });

  it("keys the counter by event and type, and stamps the event's organisation on it", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 1 });
    await getNextInvoiceNumber(mockTx, "evt-abc", "INVOICE", "HFC", "org-1");

    // The key is the event, never the organisation: two events of one organisation number separately.
    // The organisation is stamped on create AND on update, so a counter from before the column existed
    // is stamped the first time it is used (Event RLS step 5: the counter carries a row policy).
    expect(mockUpsert).toHaveBeenCalledWith({
      where: { eventId_type: { eventId: "evt-abc", type: "INVOICE" } },
      create: { eventId: "evt-abc", type: "INVOICE", lastSequence: 1, organizationId: "org-1" },
      update: { lastSequence: { increment: 1 }, organizationId: "org-1" },
    });
  });

  it("uses different event codes for different events", async () => {
    mockUpsert.mockResolvedValue({ lastSequence: 1 });

    const r1 = await getNextInvoiceNumber(mockTx, "evt-1", "INVOICE", "HFC2026", "org-1");
    const r2 = await getNextInvoiceNumber(mockTx, "evt-2", "INVOICE", "MED2026", "org-1");

    expect(r1.invoiceNumber).toBe("HFC2026-INV-001");
    expect(r2.invoiceNumber).toBe("MED2026-INV-001");
  });
});

describe("formatQuoteNumber", () => {
  it("formats as {eventCode}-Q-{serialId}", () => {
    expect(formatQuoteNumber("HFC2026", 1)).toBe("HFC2026-Q-001");
    expect(formatQuoteNumber("HFC2026", 42)).toBe("HFC2026-Q-042");
    expect(formatQuoteNumber("MED", 100)).toBe("MED-Q-100");
  });

  it("returns empty string for null serialId", () => {
    expect(formatQuoteNumber("HFC2026", null)).toBe("");
  });
});
