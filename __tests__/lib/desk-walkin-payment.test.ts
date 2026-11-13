/**
 * How a desk walk-in may be paid, by the rate chosen (owner, Oct 29, 2026):
 * complimentary only on a free rate, never beside cash and card on a paid one.
 */
import { describe, it, expect } from "vitest";
import { isComplimentaryRate, isInclusiveRate, walkInPaymentAllowed, walkInPaymentChoices, walkInPaymentLabel } from "@/lib/desk-walkin-payment";

const LINKS = ["inclusive"];

describe("walkInPaymentChoices", () => {
  it("a paid rate: cash, card or a sponsor's code; never complimentary", () => {
    expect(walkInPaymentChoices({ name: "Early Bird", price: 65 }, LINKS)).toEqual(["cash", "card", "inclusive"]);
  });

  it("the Complimentary rate: complimentary only, no sponsor choice beside it (owner, Nov 13, 2026)", () => {
    expect(walkInPaymentChoices({ name: "Complimentary", price: 0 }, LINKS)).toEqual(["complimentary"]);
    expect(walkInPaymentChoices({ name: " complimentary ", price: 0 }, [])).toEqual(["complimentary"]);
    expect(walkInPaymentAllowed("inclusive", { name: "Complimentary", price: 0 }, LINKS)).toBe(false);
  });

  it("a free rate named Inclusive that nobody marked as a link: the sponsor's code only, never complimentary", () => {
    expect(walkInPaymentChoices({ name: "Inclusive", price: 0 }, [])).toEqual(["inclusive"]);
    expect(walkInPaymentAllowed("complimentary", { name: "Inclusive", price: 0 }, [])).toBe(false);
    expect(isInclusiveRate("Inclusive")).toBe(true);
    expect(isInclusiveRate("Inclusive Plus")).toBe(false);
    expect(isInclusiveRate(null)).toBe(false);
  });

  it("any other free rate: free, or a sponsor's code (the sponsor keeps the credit on a free event)", () => {
    expect(walkInPaymentChoices({ name: "Standard", price: 0 }, LINKS)).toEqual(["complimentary", "inclusive"]);
    expect(walkInPaymentChoices({ name: "Free", price: 0 }, LINKS)).toEqual(["complimentary", "inclusive"]);
    expect(walkInPaymentChoices({ name: null, price: 0 }, LINKS)).toEqual(["complimentary", "inclusive"]);
  });

  it("a rate named Complimentary or Inclusive that is priced is a paid rate like any other", () => {
    expect(walkInPaymentChoices({ name: "Complimentary", price: 50 }, [])).toEqual(["cash", "card", "inclusive"]);
    expect(walkInPaymentChoices({ name: "Inclusive", price: 50 }, [])).toEqual(["cash", "card", "inclusive"]);
  });

  it("a sponsor-link rate: the sponsor's code only, whatever its price", () => {
    expect(walkInPaymentChoices({ name: "Inclusive", price: 0 }, LINKS)).toEqual(["inclusive"]);
    expect(walkInPaymentChoices({ name: "Inclusive", price: 200 }, LINKS)).toEqual(["inclusive"]);
  });
});

describe("walkInPaymentAllowed", () => {
  it("covered (a code took the whole fee) stands where cash and card do", () => {
    expect(walkInPaymentAllowed("covered", { name: "Standard", price: 250 }, LINKS)).toBe(true);
    expect(walkInPaymentAllowed("covered", { name: "Complimentary", price: 0 }, LINKS)).toBe(false);
  });

  it("refuses complimentary on a paid rate and cash on a free one", () => {
    expect(walkInPaymentAllowed("complimentary", { name: "Early Bird", price: 65 }, LINKS)).toBe(false);
    expect(walkInPaymentAllowed("cash", { name: "Complimentary", price: 0 }, LINKS)).toBe(false);
  });
});

describe("walkInPaymentLabel (owner, Nov 2, 2026)", () => {
  it("a rate that simply costs nothing reads Free, not Complimentary", () => {
    expect(walkInPaymentLabel("complimentary", "Standard")).toBe("Free");
    expect(walkInPaymentLabel("complimentary", null)).toBe("Free");
  });

  it("only the Complimentary rate reads Complimentary, by its slug", () => {
    expect(walkInPaymentLabel("complimentary", "Complimentary")).toBe("Complimentary");
    expect(walkInPaymentLabel("complimentary", " complimentary ")).toBe("Complimentary");
    expect(isComplimentaryRate("Complimentary Pass")).toBe(false);
  });

  it("the other choices keep their words", () => {
    expect(walkInPaymentLabel("cash", "Standard")).toBe("Cash");
    expect(walkInPaymentLabel("card", "Standard")).toBe("Card");
    expect(walkInPaymentLabel("inclusive", "Standard")).toBe("Sponsor (Inclusive)");
  });
});
