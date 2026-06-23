/**
 * Unit tests for src/lib/invoice-reconciliation-worker.ts (audit DATA-5).
 * Mocks db + the invoice-service so we can assert the candidate query is
 * acted on, params are threaded correctly, and one failing row doesn't abort
 * the batch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, mockCreatePaidInvoice, mockSendInvoiceEmail } = vi.hoisted(() => ({
  mockDb: { registration: { findMany: vi.fn() } },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockCreatePaidInvoice: vi.fn(),
  mockSendInvoiceEmail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/invoice-service", () => ({
  createPaidInvoice: mockCreatePaidInvoice,
  sendInvoiceEmail: mockSendInvoiceEmail,
}));

import { runInvoiceReconciliationTick } from "@/lib/invoice-reconciliation-worker";

function candidate(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "reg-1",
    eventId: "evt-1",
    event: { organizationId: "org-1" },
    payments: [
      { id: "pay-1", stripePaymentId: "pi_123", paymentMethodType: "card", paidAt: new Date("2026-06-20") },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreatePaidInvoice.mockResolvedValue({ id: "inv-1" });
  mockSendInvoiceEmail.mockResolvedValue(undefined);
});

describe("runInvoiceReconciliationTick", () => {
  it("is a no-op when there are no candidates", async () => {
    mockDb.registration.findMany.mockResolvedValue([]);
    const report = await runInvoiceReconciliationTick();
    expect(report).toMatchObject({ scanned: 0, reconciled: 0, failed: 0 });
    expect(mockCreatePaidInvoice).not.toHaveBeenCalled();
    expect(mockSendInvoiceEmail).not.toHaveBeenCalled();
  });

  it("only targets PAID registrations with a PAID payment and no INVOICE", async () => {
    mockDb.registration.findMany.mockResolvedValue([]);
    await runInvoiceReconciliationTick();
    const where = mockDb.registration.findMany.mock.calls[0][0].where;
    expect(where.paymentStatus).toBe("PAID");
    expect(where.invoices).toEqual({ none: { type: "INVOICE" } });
    expect(where.payments).toEqual({ some: { status: "PAID" } });
  });

  it("recovers a candidate via createPaidInvoice + sendInvoiceEmail with the payment's details", async () => {
    mockDb.registration.findMany.mockResolvedValue([candidate()]);
    const report = await runInvoiceReconciliationTick();
    expect(report).toMatchObject({ scanned: 1, reconciled: 1, failed: 0 });
    expect(mockCreatePaidInvoice).toHaveBeenCalledWith({
      registrationId: "reg-1",
      eventId: "evt-1",
      organizationId: "org-1",
      paymentId: "pay-1",
      paymentMethod: "card",
      paymentReference: "pi_123",
      paidAt: new Date("2026-06-20"),
    });
    expect(mockSendInvoiceEmail).toHaveBeenCalledWith("inv-1");
  });

  it("isolates a per-row failure — one bad row doesn't abort the batch", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      candidate({ id: "reg-bad" }),
      candidate({ id: "reg-ok" }),
    ]);
    mockCreatePaidInvoice
      .mockRejectedValueOnce(new Error("pooler blip"))
      .mockResolvedValueOnce({ id: "inv-2" });
    const report = await runInvoiceReconciliationTick();
    expect(report).toMatchObject({ scanned: 2, reconciled: 1, failed: 1 });
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "invoice-reconciliation:recover-failed", registrationId: "reg-bad" })
    );
    expect(mockSendInvoiceEmail).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'card' method when paymentMethodType is null", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      candidate({ payments: [{ id: "pay-2", stripePaymentId: null, paymentMethodType: null, paidAt: null }] }),
    ]);
    await runInvoiceReconciliationTick();
    expect(mockCreatePaidInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMethod: "card", paymentReference: undefined, paidAt: undefined })
    );
  });
});
