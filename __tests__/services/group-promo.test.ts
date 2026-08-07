/**
 * Promo codes on group registration (owner rule, Aug 2026: the code applies to
 * the FULL AND FINAL INVOICE — one discount against the consolidated total,
 * not per member).
 *
 * What's pinned: the discount lands on the invoice as one line, tax follows
 * the discounted base, a restricted code doesn't discount ineligible members,
 * the last use can't be taken twice, and — the one that costs real money — a
 * supplementary invoice never re-applies a discount already granted.
 */
import { describe, it, expect } from "vitest";
import {
  checkPromoUsable, promoDiscountFor, promoEligibleBase,
} from "@/lib/promo-validation";

/** The invoice math exactly as createGroupInvoice performs it. */
function groupInvoiceTotals(args: {
  members: Array<{ ticketTypeId: string; price: number }>;
  promo?: {
    discountType: "PERCENTAGE" | "FIXED_AMOUNT";
    discountValue: number;
    applicableTicketTypeIds: string[];
  } | null;
  applyPromo?: boolean;
  taxRatePct?: number | null;
}) {
  const { members, promo, applyPromo = true, taxRatePct = null } = args;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const subtotal = round2(members.reduce((s, m) => s + m.price, 0));
  let discountAmount = 0;
  if (applyPromo && promo) {
    discountAmount = promoDiscountFor(
      promo,
      promoEligibleBase(promo.applicableTicketTypeIds, members),
    );
  }
  const taxableBase = round2(subtotal - discountAmount);
  const taxAmount = taxRatePct ? round2(taxableBase * (taxRatePct / 100)) : 0;
  return {
    subtotal,
    discountAmount,
    taxAmount,
    total: round2(taxableBase + taxAmount),
  };
}

const MIXED = [
  { ticketTypeId: "phys", price: 250 },
  { ticketTypeId: "phys", price: 250 },
  { ticketTypeId: "nurse", price: 100 },
];

describe("group invoice with a promo code", () => {
  it("takes one discount off the consolidated total", () => {
    const t = groupInvoiceTotals({
      members: MIXED,
      promo: { discountType: "PERCENTAGE", discountValue: 10, applicableTicketTypeIds: [] },
    });
    expect(t.subtotal).toBe(600);
    expect(t.discountAmount).toBe(60);
    expect(t.total).toBe(540);
  });

  it("taxes the DISCOUNTED base — a company isn't taxed on money it wasn't charged", () => {
    const t = groupInvoiceTotals({
      members: MIXED,
      promo: { discountType: "PERCENTAGE", discountValue: 10, applicableTicketTypeIds: [] },
      taxRatePct: 5,
    });
    // 600 − 60 = 540; VAT 5% = 27; total 567. Taxing 600 would overcharge 3.00.
    expect(t.taxAmount).toBe(27);
    expect(t.total).toBe(567);
  });

  it("a type-restricted code discounts only the members it covers", () => {
    const t = groupInvoiceTotals({
      members: MIXED,
      promo: { discountType: "PERCENTAGE", discountValue: 20, applicableTicketTypeIds: ["phys"] },
    });
    // 20% of the two physicians (500), NOT of the nurse's 100.
    expect(t.discountAmount).toBe(100);
    expect(t.total).toBe(500);
  });

  it("a fixed-amount code can never exceed the group's own subtotal", () => {
    const t = groupInvoiceTotals({
      members: [{ ticketTypeId: "phys", price: 100 }],
      promo: { discountType: "FIXED_AMOUNT", discountValue: 500, applicableTicketTypeIds: [] },
    });
    expect(t.discountAmount).toBe(100);
    expect(t.total).toBe(0);
  });

  it("a SUPPLEMENTARY invoice never re-applies a discount already granted", () => {
    // People added after the group's first invoice was settled. Re-applying
    // would hand the company a second discount off one negotiation.
    const laterArrivals = [{ ticketTypeId: "phys", price: 250 }];
    const supplementary = groupInvoiceTotals({
      members: laterArrivals,
      promo: { discountType: "PERCENTAGE", discountValue: 10, applicableTicketTypeIds: [] },
      applyPromo: false,
    });
    expect(supplementary.discountAmount).toBe(0);
    expect(supplementary.total).toBe(250);

    // ...whereas a REISSUE (nothing settled) keeps the deal's discount.
    const reissue = groupInvoiceTotals({
      members: [...MIXED, ...laterArrivals],
      promo: { discountType: "PERCENTAGE", discountValue: 10, applicableTicketTypeIds: [] },
      applyPromo: true,
    });
    expect(reissue.discountAmount).toBe(85);
    expect(reissue.total).toBe(765);
  });

  it("no code means no discount and an unchanged total", () => {
    const t = groupInvoiceTotals({ members: MIXED, promo: null });
    expect(t.discountAmount).toBe(0);
    expect(t.total).toBe(600);
  });
});

describe("group promo eligibility", () => {
  const now = new Date("2026-08-07T10:00:00Z");
  const base = {
    isActive: true, validFrom: null, validUntil: null,
    maxUses: null, usedCount: 0, maxUsesPerEmail: 1,
    applicableTicketTypeIds: [] as string[],
    discountType: "PERCENTAGE" as const, discountValue: 10,
  };

  it("does NOT charge a group against the coordinator's per-email allowance", () => {
    // A group is a company deal placed by whoever is coordinating. Counting it
    // against their personal allowance would block a company's second
    // delegation — so the group path passes no emailUses.
    expect(
      checkPromoUsable({ promo: base, now, ticketTypeIds: ["phys"] }),
    ).toBeNull();
    // The individual path, which DOES pass it, still enforces the cap.
    expect(
      checkPromoUsable({ promo: base, now, ticketTypeIds: ["phys"], emailUses: 1 })?.code,
    ).toBe("MAX_USES_PER_EMAIL_REACHED");
  });

  it("still enforces the overall usage cap", () => {
    expect(
      checkPromoUsable({
        promo: { ...base, maxUses: 5, usedCount: 5 },
        now,
        ticketTypeIds: ["phys"],
      })?.code,
    ).toBe("MAX_USES_REACHED");
  });

  it("a code applying to none of the group's types is rejected outright", () => {
    expect(
      checkPromoUsable({
        promo: { ...base, applicableTicketTypeIds: ["student"] },
        now,
        ticketTypeIds: ["phys", "nurse"],
      })?.code,
    ).toBe("NOT_APPLICABLE");
  });
});
