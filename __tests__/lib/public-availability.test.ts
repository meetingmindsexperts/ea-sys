/**
 * The one availability rule every public surface shares
 * (src/lib/public-availability.ts): the public API, the register page and
 * the event page all ask it, so they cannot disagree.
 */
import { describe, it, expect } from "vitest";
import { eventIsFull, mainRegisterTarget, tierAvailability } from "@/lib/public-availability";

const NOW = new Date("2026-11-04T08:00:00Z");

describe("tierAvailability", () => {
  it("the type is the ceiling over its rates", () => {
    expect(tierAvailability({ quantity: 40, soldCount: 0, salesStart: null, salesEnd: null }, { quantity: 10, soldCount: 7 }, NOW)).toMatchObject({ available: 3, seatLimited: true, canPurchase: true });
  });

  it("a window not yet open or already shut cannot be bought; strings parse like dates", () => {
    expect(tierAvailability({ quantity: 999999, soldCount: 0, salesStart: "2026-12-01", salesEnd: null }, { quantity: 999999, soldCount: 0 }, NOW)).toMatchObject({ salesStarted: false, canPurchase: false, seatLimited: false });
    expect(tierAvailability({ quantity: 999999, soldCount: 0, salesStart: null, salesEnd: new Date("2026-11-01") }, { quantity: 999999, soldCount: 0 }, NOW)).toMatchObject({ salesEnded: true, canPurchase: false });
  });
});

describe("eventIsFull", () => {
  it("only when a cap is set and reached", () => {
    expect(eventIsFull({ maxAttendees: null, seatCount: 500 })).toBe(false);
    expect(eventIsFull({ maxAttendees: 100, seatCount: 99 })).toBe(false);
    expect(eventIsFull({ maxAttendees: 100, seatCount: 100 })).toBe(true);
  });
});

describe("mainRegisterTarget", () => {
  const t = (name: string, canPurchase = true) => ({ name, canPurchase });
  const types = [{ pricingTiers: [t("Early Bird", false), t("Standard"), t("Inclusive")] }];

  it("the first ticked rate on sale", () => {
    expect(mainRegisterTarget({ registrationOpen: true, eventFull: false, eventType: "CONFERENCE", ticketTypes: types })?.name).toBe("Standard");
  });

  it("never a sponsor-code-only rate, even when ticked", () => {
    expect(
      mainRegisterTarget({ registrationOpen: true, eventFull: false, eventType: "CONFERENCE", ticketTypes: [{ pricingTiers: [t("Inclusive")] }], mainRegisterTiers: ["inclusive"], codeRequiredTiers: ["inclusive"] }),
    ).toBeUndefined();
  });

  it("nowhere when switched off or full, except a hybrid event's virtual seats", () => {
    expect(mainRegisterTarget({ registrationOpen: false, eventFull: false, eventType: "CONFERENCE", ticketTypes: types })).toBeUndefined();
    expect(mainRegisterTarget({ registrationOpen: true, eventFull: true, eventType: "CONFERENCE", ticketTypes: types })).toBeUndefined();
    expect(mainRegisterTarget({ registrationOpen: true, eventFull: true, eventType: "HYBRID", ticketTypes: types })?.name).toBe("Standard");
  });
});
