/**
 * One rule for the payment status a fee leaves a registration in, asked by the
 * public form, by a code entered after registering, and by the script that
 * corrects the rows from before Nov 16, 2026.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { paymentStatusForFee } from "@/lib/promo-redeem";
import { promoSettlement, type SettlementCandidate } from "@/lib/promo-settlement";

describe("paymentStatusForFee", () => {
  it("the sponsor pays: INCLUSIVE", () => {
    expect(paymentStatusForFee(true, 0)).toBe("INCLUSIVE");
  });
  it("nothing owed: COMPLIMENTARY", () => {
    expect(paymentStatusForFee(false, 0)).toBe("COMPLIMENTARY");
  });
  it("a balance: UNPAID", () => {
    expect(paymentStatusForFee(false, 0.01)).toBe("UNPAID");
    expect(paymentStatusForFee(false, 200)).toBe("UNPAID");
  });
});

const ROW: SettlementCandidate = {
  status: "CONFIRMED",
  paymentStatus: "UNPAID",
  groupId: null,
  originalPrice: 200,
  discountAmount: 200,
  pricingTier: { price: 200 },
  ticketType: { price: 0 },
  promoCode: { sponsorCoversFee: false, sponsorId: null },
};

describe("promoSettlement", () => {
  it("a code that takes the whole fee: Complimentary (the Hub's thirteen nurses)", () => {
    expect(promoSettlement(ROW)).toEqual({ settle: true, to: "COMPLIMENTARY", sponsorId: null });
    expect(promoSettlement({ ...ROW, paymentStatus: "PENDING" })).toMatchObject({ settle: true, to: "COMPLIMENTARY" });
  });

  it("the sponsor's code that covers the fee: Inclusive under the sponsor", () => {
    expect(promoSettlement({ ...ROW, promoCode: { sponsorCoversFee: true, sponsorId: "sp-1" } })).toEqual({
      settle: true,
      to: "INCLUSIVE",
      sponsorId: "sp-1",
    });
  });

  it("a sponsor's code without the switch names no sponsor", () => {
    expect(promoSettlement({ ...ROW, promoCode: { sponsorCoversFee: false, sponsorId: "sp-1" } })).toEqual({
      settle: true,
      to: "COMPLIMENTARY",
      sponsorId: null,
    });
  });

  it("a balance is left alone, however small", () => {
    expect(promoSettlement({ ...ROW, discountAmount: 100 })).toEqual({ settle: false, why: "STILL_OWES" });
    expect(promoSettlement({ ...ROW, discountAmount: 199.99 })).toEqual({ settle: false, why: "STILL_OWES" });
  });

  it("a discount larger than the price is stale, not a settlement", () => {
    // Physician 500 with 500 off, moved to Nurse 200 with no rate.
    expect(promoSettlement({ ...ROW, originalPrice: 200, discountAmount: 500 })).toEqual({ settle: false, why: "STILL_OWES" });
  });

  it("a free registration with no discount is not this rule's business", () => {
    expect(promoSettlement({ ...ROW, originalPrice: 0, discountAmount: null, pricingTier: { price: 0 } })).toEqual({
      settle: false,
      why: "STILL_OWES",
    });
  });

  it("settled, cancelled, code-less and group rows are left alone", () => {
    expect(promoSettlement({ ...ROW, paymentStatus: "PAID" })).toEqual({ settle: false, why: "NOT_OUTSTANDING" });
    expect(promoSettlement({ ...ROW, paymentStatus: "COMPLIMENTARY" })).toEqual({ settle: false, why: "NOT_OUTSTANDING" });
    expect(promoSettlement({ ...ROW, paymentStatus: "REFUNDED" })).toEqual({ settle: false, why: "NOT_OUTSTANDING" });
    expect(promoSettlement({ ...ROW, status: "CANCELLED" })).toEqual({ settle: false, why: "CANCELLED" });
    expect(promoSettlement({ ...ROW, promoCode: null })).toEqual({ settle: false, why: "NO_CODE" });
    expect(promoSettlement({ ...ROW, groupId: "grp-1" })).toEqual({ settle: false, why: "GROUP_MEMBER" });
  });
});

const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const read = (rel: string) => strip(readFileSync(path.resolve(__dirname, "../..", rel), "utf8"));

describe("every writer asks the one rule", () => {
  it("the public register route and the apply service call paymentStatusForFee and keep no copy", () => {
    const route = read("src/app/api/public/events/[slug]/register/route.ts");
    const service = read("src/services/promo-code-service.ts");
    expect(route).toContain("paymentStatus: paymentStatusForFee(sponsorCovered, finalPrice),");
    expect(route).not.toContain("function initialPaymentStatus");
    expect(service).toContain("const feeStatus = paymentStatusForFee(sponsorCovered, finalPrice);");
    // Both writes inside the apply (a new code, and the same code refreshed) carry the settlement.
    expect(service.match(/\.\.\.settleData/g)?.length).toBe(2);
  });

  it("the correction script decides by promoSettlement, writes only under --write, and guards on the status it read", () => {
    const script = read("scripts/settle-promo-covered-registrations.ts");
    expect(script).toContain("const decision = promoSettlement(reg);");
    const dryRunExit = script.indexOf("if (!write) {");
    const firstWrite = script.indexOf("updateMany(");
    expect(dryRunExit).toBeGreaterThan(-1);
    expect(firstWrite).toBeGreaterThan(dryRunExit);
    expect(script).toContain("where: { id: reg.id, paymentStatus: reg.paymentStatus,");
    expect(script).not.toMatch(/sendEmail|deleteMany|\.delete\(/);
  });
});
