/**
 * One rule for the payment status a fee leaves a registration in, asked by the
 * public form, by a code entered after registering, and by the script that
 * corrects the rows from before Nov 16, 2026.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { paymentStatusForFee } from "@/lib/promo-redeem";
import { promoSettlement, settlementBlocker, type SettlementCandidate } from "@/lib/promo-settlement";

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
  paidTotal: 0,
  stripeCheckoutSessionId: null,
};

describe("settlementBlocker (asked by the service and by the script)", () => {
  it("an ordinary registration with nothing paid may be settled", () => {
    expect(settlementBlocker({ status: "CONFIRMED", groupId: null }, 0)).toBeNull();
    expect(settlementBlocker({ status: "PENDING" }, 0)).toBeNull();
  });
  it("a cancelled registration, a group member and one holding money may not", () => {
    expect(settlementBlocker({ status: "CANCELLED", groupId: null }, 0)).toBe("CANCELLED");
    expect(settlementBlocker({ status: "CONFIRMED", groupId: "grp-1" }, 0)).toBe("GROUP_MEMBER");
    expect(settlementBlocker({ status: "CONFIRMED", groupId: null }, 200)).toBe("HAS_PAYMENTS");
    expect(settlementBlocker({ status: "CONFIRMED", groupId: null }, 0.01)).toBe("HAS_PAYMENTS");
  });
});

describe("promoSettlement", () => {
  it("a code that takes the whole fee: Complimentary (the Hub's thirteen nurses)", () => {
    expect(promoSettlement(ROW)).toEqual({ settle: true, to: "COMPLIMENTARY", sponsorId: null });
    expect(promoSettlement({ ...ROW, paymentStatus: "UNASSIGNED" })).toMatchObject({ settle: true, to: "COMPLIMENTARY" });
  });

  it("a payment in progress is left to a person: the script cannot close a checkout tab", () => {
    expect(promoSettlement({ ...ROW, paymentStatus: "PENDING" })).toEqual({ settle: false, why: "CHECKOUT_OPEN" });
    expect(promoSettlement({ ...ROW, stripeCheckoutSessionId: "cs_123" })).toEqual({ settle: false, why: "CHECKOUT_OPEN" });
  });

  it("a registration that already holds money is left alone", () => {
    expect(promoSettlement({ ...ROW, paidTotal: 200 })).toEqual({ settle: false, why: "HAS_PAYMENTS" });
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
    // The desk walk-in and staff create path had a third copy (review of a9573a45).
    const create = read("src/services/registration-service.ts");
    expect(create).toContain("const byFee = paymentStatusForFee(claim.sponsorCovered, claim.finalPrice);");
    expect(create).not.toMatch(/claim\.finalPrice === 0 \? PaymentStatus\.COMPLIMENTARY/);
  });

  it("the service and the script ask the same rule for who is left alone", () => {
    const service = read("src/services/promo-code-service.ts");
    expect(service).toContain("settleBlockedBy = settlementBlocker(reg, Number(paid._sum.amount ?? 0));");
    expect(service).toContain('const settledAs = feeStatus === "UNPAID" || settleBlockedBy ? null : feeStatus;');
    expect(read("src/lib/promo-settlement.ts")).toContain("const blocker = settlementBlocker(reg, reg.paidTotal);");
  });

  it("the correction script decides by promoSettlement, writes only under --write, and guards on the status it read", () => {
    const script = read("scripts/settle-promo-covered-registrations.ts");
    expect(script).toContain("const decision = promoSettlement({ ...reg, paidTotal });");
    const dryRunExit = script.indexOf("if (!write) {");
    const firstWrite = script.indexOf("updateMany(");
    expect(dryRunExit).toBeGreaterThan(-1);
    expect(firstWrite).toBeGreaterThan(dryRunExit);
    const guard = script.slice(firstWrite, script.indexOf("data: {", firstWrite));
    for (const column of ["paymentStatus", "status", "promoCodeId", "discountAmount", "originalPrice", "ticketTypeId", "pricingTierId"]) {
      expect(guard).toContain(`${column}: reg.${column},`);
    }
    expect(guard).toContain("groupId: null,");
    expect(guard).toContain("stripeCheckoutSessionId: null,");
    // "--event" with no id refuses before anything is read.
    const main = script.slice(script.indexOf("async function main()"));
    expect(main.indexOf("if (eventFilterMissing) {")).toBeGreaterThan(-1);
    expect(main.indexOf("if (eventFilterMissing) {")).toBeLessThan(main.indexOf("db.registration.findMany"));
    expect(script).not.toMatch(/sendEmail|deleteMany|\.delete\(/);
  });
});
