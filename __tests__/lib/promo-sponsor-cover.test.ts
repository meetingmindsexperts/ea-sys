/**
 * "Sponsor covers the fee" (Sep 29, 2026): one rule for every writer, so a
 * code can never claim the sponsor pays while charging part of the fee or
 * naming no sponsor.
 */
import { describe, it, expect } from "vitest";
import { promoRegistrationLink, sponsorCoverError } from "@/lib/promo-sponsor-cover";

const ok = { sponsorCoversFee: true, sponsorId: "spn_abbott", discountType: "PERCENTAGE", discountValue: 100, maxUses: 20 };

describe("sponsorCoverError", () => {
  it("is fine when the switch is off, whatever else the code says", () => {
    expect(sponsorCoverError({ sponsorCoversFee: false, sponsorId: null, discountType: "FIXED_AMOUNT", discountValue: 5, maxUses: null })).toBeNull();
  });
  it("is fine for a sponsor's code at 100% off", () => {
    expect(sponsorCoverError(ok)).toBeNull();
  });
  it("refuses without a sponsor", () => {
    for (const sponsorId of [null, undefined, ""]) {
      expect(sponsorCoverError({ ...ok, sponsorId })).toMatch(/needs a sponsor/);
    }
  });
  it("refuses an uncapped code: the link is a bearer pass (review MED 4)", () => {
    for (const maxUses of [null, undefined, 0]) {
      expect(sponsorCoverError({ ...ok, maxUses })).toMatch(/Max Total Uses/);
    }
  });
  it("refuses anything short of 100% off", () => {
    expect(sponsorCoverError({ ...ok, discountValue: 50 })).toMatch(/100% off/);
    expect(sponsorCoverError({ ...ok, discountType: "FIXED_AMOUNT", discountValue: 100 })).toMatch(/100% off/);
  });
});

describe("promoRegistrationLink", () => {
  it("is the regular registration link with the code applied, encoded", () => {
    expect(promoRegistrationLink("https://events.example.com", "MEHF2027", "ABBOTT-7K2Q"))
      .toBe("https://events.example.com/e/MEHF2027/register?promo=ABBOTT-7K2Q");
    expect(promoRegistrationLink("https://x", "s", "A B&C")).toBe("https://x/e/s/register?promo=A%20B%26C");
  });
});
