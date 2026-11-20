/**
 * The rates the abstract form offers an author (owner, Nov 20, 2026; plan
 * docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md, P1): presenter rates where the
 * event has any, otherwise each type's ordinary rate on sale. Never Faculty,
 * never a sponsor's rate, never a type's own price when its rates are closed.
 */
import { describe, it, expect } from "vitest";
import { authorRateOptions, eventHasPresenterRates } from "@/lib/author-rates";

const rate = (id: string, name: string, price: number, sortOrder: number, canPurchase = true) => ({ id, name, price, currency: "AED", sortOrder, canPurchase });
const type = (id: string, name: string, pricingTiers: ReturnType<typeof rate>[], extra: Record<string, unknown> = {}) => ({ id, name, isActive: true, pricingTiers, ...extra });

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

  // Review of 08f6b291 (HIGH): two ways the first version gave an author a free place.
  it("never a rate that is not ticked for the main Register link: a free 'Complimentary' kept for staff is not on sale", () => {
    const types = [type("phys", "Physician", [rate("comp", "Complimentary", 0, 0), rate("incl", "Inclusive", 0, 1), rate("std", "Standard", 500, 2)])];
    expect(authorRateOptions(types).map((o) => [o.tierName, o.price])).toEqual([["Standard", 500]]);
    // Only the free rates open: nothing is offered, never the free one.
    expect(authorRateOptions([type("phys", "Physician", [rate("comp", "Complimentary", 0, 0)])])).toEqual([]);
  });

  it("the organiser's own ticked names are the ones sold", () => {
    const types = [type("phys", "Physician", [rate("m", "Member Rate", 300, 0), rate("eb", "Early Bird", 400, 1)])];
    expect(authorRateOptions(types, { mainRegisterTiers: ["member-rate"] })[0]).toMatchObject({ tierId: "m" });
    expect(authorRateOptions(types)[0]).toMatchObject({ tierId: "eb" });
  });

  it("a type with no open rate has nothing on sale, whatever its own price: rates switched off, or an event priced by type alone", () => {
    // `pricingTiers` carries active rates only. Organisers close rates with the
    // Active switch and leave the type at 0.00; and a type can itself be "Complimentary".
    expect(authorRateOptions([type("phys", "Physician", [], { price: 0 })])).toEqual([]);
    expect(authorRateOptions([type("comp", "Complimentary", [], { price: 0 }), type("phys", "Physician", [], { price: 350 })])).toEqual([]);
  });

  it("never a sponsor's rate", () => {
    // Ticked for the main link AND marked sponsor-only: the sponsor mark wins.
    const types = [type("phys", "Physician", [rate("sp", "Sponsored Seat", 0, 0), rate("eb", "Early Bird", 400, 1)])];
    const ctx = { mainRegisterTiers: ["sponsored-seat", "early-bird"], codeRequiredTiers: ["sponsored-seat"] };
    expect(authorRateOptions(types, ctx)[0]).toMatchObject({ tierId: "eb", price: 400 });
    expect(authorRateOptions(types, { mainRegisterTiers: ["sponsored-seat", "early-bird"] })[0]).toMatchObject({ tierId: "sp" });
  });

  it("a type whose rates are all closed is not offered at its own price", () => {
    const types = [type("phys", "Physician", [rate("eb", "Early Bird", 400, 0, false)], { price: 0 })];
    expect(authorRateOptions(types)).toEqual([]);
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
