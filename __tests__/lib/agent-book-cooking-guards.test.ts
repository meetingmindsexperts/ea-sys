/**
 * Book-cooking write guards (payments review H12 + M6, July 10 2026).
 *
 * paymentStatus REFUNDED/PENDING/FAILED and invoice PAID/REFUNDED used to be
 * settable as bare flags via the MCP executors — producing regs labeled
 * REFUNDED with refundedAmount 0 / no credit note / Payment rows still PAID,
 * or PAID invoices with no Payment behind them. These pin the rejections.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    registration: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    invoice: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    event: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn() }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/person-tag-sync", () => ({
  computeTagDelta: vi.fn(() => ({ added: [], removed: [] })),
  syncRegistrationTagsToSpeakers: vi.fn(),
}));

import { TOOL_EXECUTOR_MAP } from "@/lib/agent/event-tools";

const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registration.findFirst.mockResolvedValue({
    id: "reg1", eventId: "ev1", status: "CONFIRMED", paymentStatus: "PAID",
    sponsorId: null, ticketTypeId: "tt1", pricingTierId: null,
    attendanceMode: "IN_PERSON", createdSource: null, promoCodeId: null,
    discountAmount: null, qrCode: "QR", attendeeId: "att1",
    attendee: { id: "att1", firstName: "A", lastName: "B", email: "a@b.com", tags: [] },
  });
  // The registration-update service loads the event (settings) alongside the
  // registration before validating paymentStatus — fixture it so the guard
  // under test (and not a NOT_FOUND) is what fires.
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: {} });
});

describe("update_registration — H12", () => {
  it.each(["REFUNDED", "PENDING", "FAILED"])("rejects paymentStatus=%s with PAYMENT_STATUS_NOT_SETTABLE", async (status) => {
    const result = await TOOL_EXECUTOR_MAP.update_registration({ registrationId: "reg1", paymentStatus: status }, ctx);
    expect(result).toMatchObject({ code: "PAYMENT_STATUS_NOT_SETTABLE" });
    expect(String((result as { error: string }).error)).toContain("refund flow");
    expect(mockDb.registration.update).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});

describe("bulk_update_registration_status — H12", () => {
  it("rejects paymentStatus=REFUNDED on the bulk path (the '200 regs marked refunded' hole)", async () => {
    const result = await TOOL_EXECUTOR_MAP.bulk_update_registration_status(
      { registrationIds: ["reg1", "reg2"], paymentStatus: "REFUNDED" },
      ctx,
    );
    expect(result).toMatchObject({ code: "PAYMENT_STATUS_NOT_SETTABLE" });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("still accepts an admin-settable value (COMPLIMENTARY passes validation)", async () => {
    mockDb.registration.findMany.mockResolvedValue([]);
    mockDb.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({ registration: { findMany: vi.fn().mockResolvedValue([]), updateMany: mockDb.registration.updateMany } }),
    );
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
    const result = await TOOL_EXECUTOR_MAP.bulk_update_registration_status(
      { registrationIds: ["reg1"], paymentStatus: "COMPLIMENTARY" },
      ctx,
    );
    expect(result).not.toMatchObject({ code: "PAYMENT_STATUS_NOT_SETTABLE" });
  });
});

describe("update_invoice_status — M6", () => {
  it.each(["PAID", "REFUNDED", "SENT", "DRAFT"])("rejects %s with INVOICE_STATUS_NOT_SETTABLE (no DB write)", async (status) => {
    const result = await TOOL_EXECUTOR_MAP.update_invoice_status({ invoiceId: "inv1", status }, ctx);
    expect(result).toMatchObject({ code: "INVOICE_STATUS_NOT_SETTABLE" });
    expect(mockDb.invoice.update).not.toHaveBeenCalled();
  });

  it("still allows CANCELLED (dashboard parity — now via the shared cancelInvoice helper)", async () => {
    mockDb.invoice.findFirst.mockResolvedValue({ id: "inv1" });
    // The transition helper (invoice-service, finding 5) re-reads via findUniqueOrThrow.
    mockDb.invoice.findUniqueOrThrow.mockResolvedValue({ id: "inv1", status: "SENT", invoiceNumber: "MM-1", eventId: "ev1" });
    mockDb.invoice.update.mockResolvedValue({ id: "inv1", invoiceNumber: "MM-1", status: "CANCELLED", total: 100, currency: "USD", paidDate: null });
    const result = await TOOL_EXECUTOR_MAP.update_invoice_status({ invoiceId: "inv1", status: "CANCELLED" }, ctx);
    expect(result).toMatchObject({ success: true, invoice: { status: "CANCELLED" } });
    expect(mockDb.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "CANCELLED" } }),
    );
    // The MCP path now audits via the shared helper (was a hand-rolled row).
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "Invoice",
        changes: expect.objectContaining({ source: "mcp", before: "SENT", after: "CANCELLED" }),
      }),
    });
  });
});
