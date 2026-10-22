/**
 * Payment reminders never reach complimentary or sponsor-paid registrations
 * (owner, Oct 22, 2026): the shared predicate, and the bulk send's audience,
 * where a paymentStatus filter must not re-admit them.
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
    expect(excludedAsNoBalance("payment-reminder", s)).toBe(true);
  });
  it.each(["UNPAID", "PENDING", "UNASSIGNED", "PAID"])("keeps %s (other filters decide)", (s) => {
    expect(excludedAsNoBalance("payment-reminder", s)).toBe(false);
  });
  it("only applies to payment reminders", () => {
    expect(excludedAsNoBalance("event-reminder", "COMPLIMENTARY")).toBe(false);
  });
});

describe("bulk payment reminder audience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", organizationId: "org-1", settings: {} });
    mockDb.registration.findMany.mockResolvedValue([]);
  });

  it("excludes complimentary and sponsor-paid, even when the filter names them", async () => {
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
    expect(where.AND).toEqual([{ paymentStatus: { notIn: ["COMPLIMENTARY", "INCLUSIVE"] } }]);
    expect(where.paymentStatus).toEqual({ in: ["COMPLIMENTARY", "UNPAID"] });
  });
});
