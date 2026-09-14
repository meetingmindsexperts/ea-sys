/**
 * The "Paid" card counts money collected only (Sep 14, 2026): a free event
 * with 123 complimentary delegates must read "0" with "123 complimentary"
 * under it, not "Paid 123".
 */
import { describe, it, expect } from "vitest";
import { paidCardNote, summarizePaymentStatuses } from "@/lib/registration-payment-stats";

const rows = (...statuses: string[]) => statuses.map((paymentStatus) => ({ paymentStatus }));

describe("summarizePaymentStatuses", () => {
  it("keeps complimentary and sponsor-paid out of the paid count", () => {
    expect(summarizePaymentStatuses(rows("COMPLIMENTARY", "COMPLIMENTARY", "PAID", "INCLUSIVE", "UNPAID", "PENDING"))).toEqual({
      paid: 1,
      complimentary: 2,
      inclusive: 1,
    });
  });
  it("is all zeros for no rows", () => {
    expect(summarizePaymentStatuses([])).toEqual({ paid: 0, complimentary: 0, inclusive: 0 });
  });
});

describe("paidCardNote", () => {
  it("names the free and sponsor-paid counts, and only the ones present", () => {
    expect(paidCardNote({ paid: 0, complimentary: 123, inclusive: 0 })).toBe("123 complimentary");
    expect(paidCardNote({ paid: 40, complimentary: 12, inclusive: 3 })).toBe("12 complimentary · 3 sponsor-paid");
    expect(paidCardNote({ paid: 5, complimentary: 0, inclusive: 2 })).toBe("2 sponsor-paid");
  });
  it("stays silent on a plain paid event", () => {
    expect(paidCardNote({ paid: 40, complimentary: 0, inclusive: 0 })).toBeNull();
  });
});
