/**
 * A promo code typed on the public form and never applied is checked before
 * the registration is sent, never dropped (owner, Nov 16, 2026).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { unappliedPromoCode } from "@/lib/promo-entry";

describe("unappliedPromoCode", () => {
  it("a code typed and never checked is returned, trimmed", () => {
    expect(unappliedPromoCode("GCCHH26SEHA", true, null)).toBe("GCCHH26SEHA");
    expect(unappliedPromoCode("  SEHA ", true, null)).toBe("SEHA");
  });

  it("a code the check refused is still unapplied: it is checked again, not dropped", () => {
    expect(unappliedPromoCode("WRONG", true, { valid: false })).toBe("WRONG");
  });

  it("a code the check accepted needs nothing more", () => {
    expect(unappliedPromoCode("SEHA", true, { valid: true })).toBeNull();
  });

  it("an empty field is nothing to check", () => {
    expect(unappliedPromoCode("", true, null)).toBeNull();
    expect(unappliedPromoCode("   ", true, { valid: false })).toBeNull();
  });

  it("a field the form is not showing never blocks a submit the person cannot correct", () => {
    expect(unappliedPromoCode("LINKED", false, null)).toBeNull();
    expect(unappliedPromoCode("LINKED", false, { valid: false })).toBeNull();
  });
});

describe("the public registration form asks the rule", () => {
  const page = readFileSync(
    path.resolve(__dirname, "../../src/app/e/[slug]/register/[category]/page.tsx"),
    "utf8",
  );
  const code = page.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  it("checks a typed code before it sends the registration", () => {
    const check = code.indexOf("unappliedPromoCode(promoCode, promoFieldShown, promoResult)");
    const send = code.indexOf("/register`");
    expect(check).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(check);
  });

  it("sends the code the submit-time check accepted, not only the one Apply accepted", () => {
    expect(code).toContain("promoCode: appliedPromo?.valid ? appliedPromo.code : undefined");
    expect(code).not.toContain("promoCode: promoResult?.valid ? promoResult.code : undefined");
  });

  it("the field the submit reads is the field the page renders", () => {
    expect(code).toContain("{promoBlockOffered && (");
    expect(code).toContain("{!promoFieldShown ? (");
  });

  it("Enter in the code field applies the code instead of submitting the form", () => {
    const field = code.slice(code.indexOf('placeholder="Enter promo code"'));
    expect(field.slice(0, 900)).toMatch(/onKeyDown=\{[\s\S]*e\.key !== "Enter"[\s\S]*e\.preventDefault\(\)[\s\S]*applyPromo\(promoCode\)/);
  });
});
