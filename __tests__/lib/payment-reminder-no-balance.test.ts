/**
 * Payment reminders never reach complimentary or sponsor-paid registrations
 * (owner, Oct 22, 2026), nor one with no type yet (Nov 9, 2026: an import left
 * blank is UNASSIGNED with no price to remind them of): the shared predicate,
 * and the bulk send's audience, where a paymentStatus filter must not
 * re-admit them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendEmail: vi.fn(), getEventTemplate: vi.fn(), getDefaultTemplate: vi.fn(), renderAndWrap: vi.fn(), loadActiveEventTemplateRow: vi.fn() };
});

import { excludedAsNoBalance } from "@/lib/bulk-email-audience";
import { executeBulkEmail } from "@/lib/bulk-email";

describe("excludedAsNoBalance", () => {
  it.each(["COMPLIMENTARY", "INCLUSIVE"])("leaves %s out of a payment reminder", (s) => {
    expect(excludedAsNoBalance("payment-reminder", s, true, 0)).toBe(true);
    // The status alone decides, even where the balance is unknown.
    expect(excludedAsNoBalance("payment-reminder", s, true, null)).toBe(true);
  });
  it.each(["UNPAID", "PENDING", "UNASSIGNED", "FAILED"])("keeps %s with a type and a balance to pay", (s) => {
    expect(excludedAsNoBalance("payment-reminder", s, true, 210)).toBe(false);
  });
  it.each(["UNASSIGNED", "UNPAID"])("leaves a %s registration with no type out: nothing is priced yet", (s) => {
    expect(excludedAsNoBalance("payment-reminder", s, false, 210)).toBe(true);
  });
  it("only applies to payment reminders", () => {
    expect(excludedAsNoBalance("event-reminder", "COMPLIMENTARY", true, 0)).toBe(false);
    expect(excludedAsNoBalance("event-reminder", "UNASSIGNED", false, 0)).toBe(false);
    expect(excludedAsNoBalance("event-reminder", "UNPAID", true, 0)).toBe(false);
  });

  // Owner, Nov 12, 2026: "if someone is 0 or owes nothing, dont send any
  // payment related emails". Five nurses on the 4th GCC Hematology Hub entered
  // a 100% code after registering: UNPAID, nothing due.
  it.each(["UNPAID", "PENDING", "UNASSIGNED", "FAILED", "PAID", "REFUNDED"])("leaves %s out when nothing is left to pay", (s) => {
    expect(excludedAsNoBalance("payment-reminder", s, true, 0)).toBe(true);
  });
  it("treats a balance that is not a positive number as nothing to pay", () => {
    expect(excludedAsNoBalance("payment-reminder", "UNPAID", true, -5)).toBe(true);
    expect(excludedAsNoBalance("payment-reminder", "UNPAID", true, Number.NaN)).toBe(true);
    expect(excludedAsNoBalance("payment-reminder", "UNPAID", true, 0.01)).toBe(false);
  });
  it("lets the status and the type decide where the balance cannot be known", () => {
    expect(excludedAsNoBalance("payment-reminder", "UNPAID", true, null)).toBe(false);
    expect(excludedAsNoBalance("payment-reminder", "UNPAID", false, null)).toBe(true);
  });
});

describe("bulk payment reminder audience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", organizationId: "org-1", settings: {} });
    mockDb.registration.findMany.mockResolvedValue([]);
  });

  it("excludes complimentary, sponsor-paid and typeless, even when the filter names them", async () => {
    await executeBulkEmail({
      eventId: "evt-1",
      recipientType: "registrations",
      emailType: "payment-reminder",
      organizerName: "Org",
      organizerEmail: "org@x.com",
      organizationId: "org-1",
      triggeredByUserId: "u1",
      filters: { paymentStatus: "COMPLIMENTARY,UNPAID" },
    }).catch(() => undefined);
    const where = mockDb.registration.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([{ paymentStatus: { notIn: ["COMPLIMENTARY", "INCLUSIVE"] } }, { ticketTypeId: { not: null } }]);
    expect(where.paymentStatus).toEqual({ in: ["COMPLIMENTARY", "UNPAID"] });
  });
});
