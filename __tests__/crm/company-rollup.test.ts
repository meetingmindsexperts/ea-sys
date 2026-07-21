/**
 * Companies-table rollups — accumulated deal value + derived primary contact.
 *
 * Pins the owner decisions (July 21, 2026): totals count OPEN+WON only, per
 * currency (never summed across — the H2 fabricated-number rule); "primary
 * contact" is the PRIMARY role on the newest deal, else the newest company
 * contact — derived, not stored.
 */
import { describe, it, expect } from "vitest";
import { companyDealTotals, companyPrimaryContact, type RollupDeal } from "@/crm/lib/company-rollup";

const deal = (over: Partial<RollupDeal>): RollupDeal => ({
  status: "OPEN",
  dealValue: 1000,
  currency: "USD",
  contacts: [],
  ...over,
});

describe("companyDealTotals", () => {
  it("sums OPEN + WON, excludes LOST", () => {
    const totals = companyDealTotals([
      deal({ status: "OPEN", dealValue: 10_000 }),
      deal({ status: "WON", dealValue: 40_000 }),
      deal({ status: "LOST", dealValue: 99_000 }),
    ]);
    expect(totals).toEqual([{ currency: "USD", total: 50_000 }]);
  });

  it("NEVER sums across currencies — one entry per currency, largest first (currency tiebreak)", () => {
    const totals = companyDealTotals([
      deal({ dealValue: 5_000, currency: "AED" }),
      deal({ dealValue: 30_000, currency: "USD" }),
      deal({ dealValue: 15_000, currency: "AED" }),
    ]);
    expect(totals).toEqual([
      { currency: "USD", total: 30_000 },
      { currency: "AED", total: 20_000 },
    ]);
    // Equal totals order deterministically by currency name.
    expect(
      companyDealTotals([deal({ dealValue: 10, currency: "USD" }), deal({ dealValue: 10, currency: "AED" })]),
    ).toEqual([
      { currency: "AED", total: 10 },
      { currency: "USD", total: 10 },
    ]);
  });

  it("valueless / unparsable deals contribute nothing; no deals → empty", () => {
    expect(companyDealTotals([deal({ dealValue: null }), deal({ dealValue: "n/a" })])).toEqual([]);
    expect(companyDealTotals([])).toEqual([]);
  });

  it("accepts Decimal-style string values (Prisma serialization)", () => {
    expect(companyDealTotals([deal({ dealValue: "2500.50" })])).toEqual([
      { currency: "USD", total: 2500.5 },
    ]);
  });
});

describe("companyPrimaryContact", () => {
  const sara = { id: "cc-1", firstName: "Sara", lastName: "Khan" };
  const omar = { id: "cc-2", firstName: "Omar", lastName: "Aziz" };

  it("takes the PRIMARY on the NEWEST deal (list arrives newest-first)", () => {
    const picked = companyPrimaryContact(
      [
        deal({ contacts: [{ crmContact: sara }] }), // newest
        deal({ contacts: [{ crmContact: omar }] }),
      ],
      omar,
    );
    expect(picked).toEqual(sara);
  });

  it("skips deals with no PRIMARY and falls through to the next", () => {
    const picked = companyPrimaryContact([deal({ contacts: [] }), deal({ contacts: [{ crmContact: omar }] })], null);
    expect(picked).toEqual(omar);
  });

  it("falls back to the company's newest contact, else null", () => {
    expect(companyPrimaryContact([deal({ contacts: [] })], sara)).toEqual(sara);
    expect(companyPrimaryContact([], null)).toBeNull();
  });
});
