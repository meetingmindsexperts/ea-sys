/**
 * The desk's day summary (owner, Nov 2, 2026): walk-ins by rate, and the cash
 * and card per desk user. Free and comp share the COMPLIMENTARY status, so the
 * rate tells them apart.
 */
import { describe, it, expect } from "vitest";
import { deskDayBounds, isDeskDate, summariseDeskDay, walkInBucket } from "@/lib/desk-day-summary";

describe("walkInBucket", () => {
  it("a free rate that is not the Complimentary rate is Free", () => {
    expect(walkInBucket({ paymentStatus: "COMPLIMENTARY", rateName: "Standard", ratePrice: 0 })).toBe("free");
    expect(walkInBucket({ paymentStatus: "COMPLIMENTARY", rateName: null, ratePrice: 0 })).toBe("free");
  });

  it("the Complimentary rate, or a 100% code on a paid rate, is Comp", () => {
    expect(walkInBucket({ paymentStatus: "COMPLIMENTARY", rateName: "Complimentary", ratePrice: 0 })).toBe("comp");
    expect(walkInBucket({ paymentStatus: "COMPLIMENTARY", rateName: "Early Bird", ratePrice: 65 })).toBe("comp");
  });

  it("sponsor, paid, and a payment that never recorded", () => {
    expect(walkInBucket({ paymentStatus: "INCLUSIVE", rateName: "Standard", ratePrice: 0 })).toBe("sponsor");
    expect(walkInBucket({ paymentStatus: "PAID", rateName: "Standard", ratePrice: 250 })).toBe("paid");
    expect(walkInBucket({ paymentStatus: "UNASSIGNED", rateName: "Standard", ratePrice: 250 })).toBe("unpaid");
  });
});

describe("summariseDeskDay", () => {
  it("counts walk-ins per type and rate, and money per user, method and currency", () => {
    const s = summariseDeskDay(
      [
        { paymentStatus: "COMPLIMENTARY", ticketTypeName: "Delegate", rateName: "Standard", ratePrice: 0 },
        { paymentStatus: "COMPLIMENTARY", ticketTypeName: "Delegate", rateName: "Standard", ratePrice: 0 },
        { paymentStatus: "COMPLIMENTARY", ticketTypeName: "Delegate", rateName: "Complimentary", ratePrice: 0 },
        { paymentStatus: "PAID", ticketTypeName: "Workshop", rateName: null, ratePrice: 100 },
      ],
      [
        { method: "cash", currency: "usd", amount: 100, refunded: 0, recordedByUserId: "u1" },
        { method: "cash", currency: "USD", amount: 50.1, refunded: 10, recordedByUserId: "u1" },
        { method: "card_onsite", currency: "USD", amount: 75, refunded: 0, recordedByUserId: "u2" },
      ],
    );
    expect(s.walkIns.total).toBe(4);
    expect(s.walkIns.totals).toEqual({ free: 2, comp: 1, sponsor: 0, paid: 1, unpaid: 0 });
    expect(s.walkIns.byRate.map((r) => [r.ticketTypeName, r.rateName])).toEqual([
      ["Delegate", "Complimentary"],
      ["Delegate", "Standard"],
      ["Workshop", null],
    ]);
    expect(s.money.byUser).toEqual([
      { userId: "u1", method: "cash", currency: "USD", count: 2, amount: 150.1, refunded: 10 },
      { userId: "u2", method: "card_onsite", currency: "USD", count: 1, amount: 75, refunded: 0 },
    ]);
    expect(s.money.totals).toEqual([
      { method: "cash", currency: "USD", count: 2, amount: 150.1, refunded: 10 },
      { method: "card_onsite", currency: "USD", count: 1, amount: 75, refunded: 0 },
    ]);
  });
});

describe("the day", () => {
  it("a calendar day in the event's timezone", () => {
    const { start, end } = deskDayBounds("2026-11-02", "Asia/Dubai");
    expect(start.toISOString()).toBe("2026-11-01T20:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-02T20:00:00.000Z");
  });

  it("rolls over a month end", () => {
    expect(deskDayBounds("2026-11-30", "UTC").end.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("refuses a malformed or impossible date", () => {
    expect(isDeskDate("2026-11-02")).toBe(true);
    expect(isDeskDate("2026-02-31")).toBe(false);
    expect(isDeskDate("02-11-2026")).toBe(false);
    expect(isDeskDate(null)).toBe(false);
  });
});
