/**
 * The rates the abstract form offers an author (owner, Nov 20, 2026; plan
 * docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md, P1): presenter rates where the
 * event has any, otherwise each type's ordinary rate on sale. Never Faculty,
 * never a sponsor's rate, never a type's own price when its rates are closed.
 */
import { describe, it, expect } from "vitest";
import { authorRateOptions, eventHasPresenterRates } from "@/lib/author-rates";

const rate = (id: string, name: string, price: number, sortOrder: number, canPurchase = true) => ({ id, name, price, currency: "AED", sortOrder, canPurchase });
const type = (id: string, name: string, pricingTiers: ReturnType<typeof rate>[], extra: Record<string, unknown> = {}) => ({ id, name, isActive: true, price: 0, currency: "AED", canPurchase: true, pricingTiers, ...extra });

describe("an event WITH presenter rates", () => {
  const types = [
    type("phys", "Physician", [rate("eb", "Early Bird", 400, 0), rate("pr", "Presenter", 350, 3)]),
    type("exh", "Exhibitor", [rate("eb2", "Early Bird", 900, 0)]),
  ];

  it("offers the presenter rate, and only on the types that have one", () => {
    expect(eventHasPresenterRates(types)).toBe(true);
    expect(authorRateOptions(types)).toEqual([
      { ticketTypeId: "phys", ticketTypeName: "Physician", tierId: "pr", tierName: "Presenter", price: 350, currency: "AED" },
    ]);
  });

  it("with every presenter rate closed it offers nothing: no slide into the ordinary rates", () => {
    const closed = [type("phys", "Physician", [rate("eb", "Early Bird", 400, 0), rate("pr", "Presenter", 350, 3, false)])];
    expect(authorRateOptions(closed)).toEqual([]);
  });

  it("presenter rates are offered whatever the public registration switch says, as before", () => {
    expect(authorRateOptions(types, { registrationOpen: false })).toHaveLength(1);
  });
});

describe("an event with NO presenter rates", () => {
  it("offers each type's first open ordinary rate, in the organiser's order", () => {
    const types = [
      type("phys", "Physician", [rate("std", "Standard", 500, 1), rate("eb", "Early Bird", 400, 0)]),
      type("nurse", "Nurse", [rate("eb-n", "Early Bird", 200, 0, false), rate("std-n", "Standard", 250, 1)]),
    ];
    expect(authorRateOptions(types).map((o) => [o.ticketTypeName, o.tierName, o.price])).toEqual([
      ["Physician", "Early Bird", 400],
      ["Nurse", "Standard", 250],
    ]);
  });

  it("never a sponsor's rate", () => {
    const types = [type("phys", "Physician", [rate("sp", "Sponsored Seat", 0, 0), rate("eb", "Early Bird", 400, 1)])];
    expect(authorRateOptions(types, { codeRequiredTiers: ["sponsored-seat"] })[0]).toMatchObject({ tierId: "eb", price: 400 });
  });

  it("a type whose rates are all closed is not offered at its own price", () => {
    const types = [type("phys", "Physician", [rate("eb", "Early Bird", 400, 0, false)], { price: 0 })];
    expect(authorRateOptions(types)).toEqual([]);
  });

  it("a type with no rates is sold at its own price, while it is on sale", () => {
    expect(authorRateOptions([type("phys", "Physician", [], { price: 300 })])).toEqual([
      { ticketTypeId: "phys", ticketTypeName: "Physician", tierId: null, tierName: "", price: 300, currency: "AED" },
    ]);
    expect(authorRateOptions([type("phys", "Physician", [], { price: 300, canPurchase: false })])).toEqual([]);
  });

  it("with public registration switched off nothing is offered", () => {
    const types = [type("phys", "Physician", [rate("eb", "Early Bird", 400, 0)])];
    expect(authorRateOptions(types, { registrationOpen: false })).toEqual([]);
    expect(authorRateOptions(types, { registrationOpen: true })).toHaveLength(1);
  });

  it("an inactive type is never offered, and nothing at all is an empty list", () => {
    expect(authorRateOptions([type("phys", "Physician", [rate("eb", "Early Bird", 400, 0)], { isActive: false })])).toEqual([]);
    expect(authorRateOptions(null)).toEqual([]);
    expect(authorRateOptions([])).toEqual([]);
  });
});
