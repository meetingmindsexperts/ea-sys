/**
 * The desk QR token and its rules (docs/ONSITE_DESK_PLAN.md §8.4, §8.5).
 */
import { createHmac } from "crypto";
import { describe, it, expect } from "vitest";

process.env.NEXTAUTH_SECRET = "test-secret-for-desk-qr";

import { mintDeskQrToken, verifyDeskQrToken, DESK_QR_TTL_SECONDS, type DeskQrSubject } from "@/lib/desk-qr-token";
import { deskQrPriceRefusal, deskQrReopensClosedRate, deskQrTakesCode, deskQrTypeRefusal, freeDeskRate, readDeskQrClaims, type FreeRateType } from "@/lib/desk-qr-rules";

const COMP: DeskQrSubject = { eventId: "evt-1", kind: "complimentary", rate: "complimentary", promoCodeId: null, issuedBy: "staff-1" };
const EXH: DeskQrSubject = { eventId: "evt-1", kind: "exhibitor", rate: "inclusive", promoCodeId: null, issuedBy: "desk" };
const FREE: DeskQrSubject = { eventId: "evt-1", kind: "free", rate: "standard", promoCodeId: null, issuedBy: "desk" };

describe("the token", () => {
  it("verifies for 30 minutes, then is expired", () => {
    const now = Date.now();
    const { token, expiresAt } = mintDeskQrToken(COMP, now);
    expect(expiresAt.getTime()).toBe(Math.floor(now / 1000) * 1000 + DESK_QR_TTL_SECONDS * 1000);
    expect(verifyDeskQrToken(token, now + 29 * 60_000)).toMatchObject({ ok: true, payload: { kind: "complimentary", rate: "complimentary", issuedBy: "staff-1" } });
    expect(verifyDeskQrToken(token, now + 31 * 60_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("each QR has its own id", () => {
    const a = verifyDeskQrToken(mintDeskQrToken(COMP).token);
    const b = verifyDeskQrToken(mintDeskQrToken(COMP).token);
    expect(a.ok && b.ok && a.payload.jti !== b.payload.jti).toBe(true);
  });

  it("a changed body or a foreign signature is refused", () => {
    const [body, sig] = mintDeskQrToken(COMP).token.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    const changed = Buffer.from(JSON.stringify({ ...payload, kind: "exhibitor", promoCodeId: "x" })).toString("base64url");
    expect(verifyDeskQrToken(`${changed}.${sig}`)).toEqual({ ok: false, reason: "signature" });
    expect(verifyDeskQrToken("nonsense")).toEqual({ ok: false, reason: "malformed" });
  });

  it("with `until`: valid until then, and the same token every time (a printed sheet matches the screen)", () => {
    const until = new Date(Date.now() + 3 * 86_400_000);
    const a = mintDeskQrToken(EXH, Date.now(), until);
    const b = mintDeskQrToken(EXH, Date.now() + 60_000, until);
    expect(a.token).toBe(b.token);
    expect(a.expiresAt.getTime()).toBe(Math.floor(until.getTime() / 1000) * 1000);
    expect(verifyDeskQrToken(a.token, until.getTime() - 1000).ok).toBe(true);
    expect(verifyDeskQrToken(a.token, until.getTime() + 1000)).toEqual({ ok: false, reason: "expired" });
    expect(mintDeskQrToken({ ...EXH, kind: "complimentary", rate: "complimentary" }, Date.now(), until).token).not.toBe(a.token);
  });

  it("carries the free kind, and refuses a kind it does not know", () => {
    const { token } = mintDeskQrToken(FREE);
    expect(verifyDeskQrToken(token)).toMatchObject({ ok: true, payload: { kind: "free", rate: "standard" } });
    // A kind from a later image (or a forged one, signed with the secret): malformed, never a guess.
    const [body] = token.split(".");
    const unknown = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), kind: "vip" })).toString("base64url");
    const sig = createHmac("sha256", process.env.NEXTAUTH_SECRET!).update(`desk-qr:v1.${unknown}`).digest("base64url");
    expect(verifyDeskQrToken(`${unknown}.${sig}`)).toEqual({ ok: false, reason: "malformed" });
  });
});

const rate = (name: string, requiresApproval = false) => ({ name, requiresApproval });

describe("the type and rate", () => {
  it("only the QR's rate", () => {
    expect(deskQrTypeRefusal(COMP, "Physician", rate("Complimentary"))).toBeNull();
    expect(deskQrTypeRefusal(COMP, "Physician", rate("Standard"))).toBe("DESK_QR_WRONG_RATE");
    expect(deskQrTypeRefusal(COMP, "Physician", null)).toBe("DESK_QR_WRONG_RATE");
  });

  it("exhibitors are always exhibitors; complimentary never is", () => {
    expect(deskQrTypeRefusal(EXH, "Exhibitor", rate("Inclusive"))).toBeNull();
    expect(deskQrTypeRefusal(EXH, "Physician", rate("Inclusive"))).toBe("DESK_QR_WRONG_TYPE");
    expect(deskQrTypeRefusal(COMP, " exhibitor ", rate("Complimentary"))).toBe("DESK_QR_WRONG_TYPE");
  });

  it("a free QR: its own rate, any type but Exhibitor", () => {
    expect(deskQrTypeRefusal(FREE, "Physician", rate("Standard"))).toBeNull();
    expect(deskQrTypeRefusal(FREE, "Physician", rate("Early Bird"))).toBe("DESK_QR_WRONG_RATE");
    expect(deskQrTypeRefusal(FREE, "Exhibitor", rate("Standard"))).toBe("DESK_QR_WRONG_TYPE");
    expect(deskQrTypeRefusal(FREE, "Physician", rate("Standard", true))).toBe("DESK_QR_NEEDS_APPROVAL");
  });

  it("never a rate that needs approval (owner, Oct 29)", () => {
    expect(deskQrTypeRefusal(COMP, "Physician", rate("Complimentary", true))).toBe("DESK_QR_NEEDS_APPROVAL");
    expect(deskQrTypeRefusal(EXH, "Exhibitor", rate("Inclusive", true))).toBe("DESK_QR_NEEDS_APPROVAL");
  });
});

describe("the code and the price", () => {
  it("an exhibitor types any sponsor's code that covers the fee; it credits that sponsor", () => {
    expect(deskQrPriceRefusal(EXH, { promoCodeId: "promo-csl", sponsorCovered: true, finalPrice: 0 })).toBeNull();
    expect(deskQrPriceRefusal(EXH, { promoCodeId: "promo-roche", sponsorCovered: true, finalPrice: 0 })).toBeNull();
    expect(deskQrPriceRefusal(EXH, { promoCodeId: "promo-x", sponsorCovered: false, finalPrice: 0 })).toBe("DESK_QR_CODE_REQUIRED");
    expect(deskQrPriceRefusal(EXH, { promoCodeId: null, sponsorCovered: false, finalPrice: 0 })).toBe("DESK_QR_CODE_REQUIRED");
  });

  it("a QR that names a sponsor's code takes only that one", () => {
    const named = { ...EXH, promoCodeId: "promo-csl" };
    expect(deskQrPriceRefusal(named, { promoCodeId: "promo-roche", sponsorCovered: true, finalPrice: 0 })).toBe("DESK_QR_WRONG_CODE");
  });

  it("complimentary takes no code, and nothing may cost money", () => {
    expect(deskQrPriceRefusal(COMP, { promoCodeId: null, sponsorCovered: false, finalPrice: 0 })).toBeNull();
    expect(deskQrPriceRefusal(COMP, { promoCodeId: "promo-x", sponsorCovered: false, finalPrice: 0 })).toBe("DESK_QR_WRONG_CODE");
    expect(deskQrPriceRefusal(COMP, { promoCodeId: null, sponsorCovered: false, finalPrice: 10 })).toBe("DESK_QR_NOT_FREE");
  });

  it("a free QR takes no code either, and a rate that gained a price is refused", () => {
    expect(deskQrPriceRefusal(FREE, { promoCodeId: null, sponsorCovered: false, finalPrice: 0 })).toBeNull();
    expect(deskQrPriceRefusal(FREE, { promoCodeId: "promo-x", sponsorCovered: true, finalPrice: 0 })).toBe("DESK_QR_WRONG_CODE");
    expect(deskQrPriceRefusal(FREE, { promoCodeId: null, sponsorCovered: false, finalPrice: 150 })).toBe("DESK_QR_NOT_FREE");
  });

  it("only an exhibitor's QR takes a code; only the free QR leaves a closed rate closed", () => {
    expect([deskQrTakesCode("exhibitor"), deskQrTakesCode("complimentary"), deskQrTakesCode("free")]).toEqual([true, false, false]);
    expect([deskQrReopensClosedRate("exhibitor"), deskQrReopensClosedRate("complimentary"), deskQrReopensClosedRate("free")]).toEqual([true, true, false]);
  });
});

describe("what the form reads", () => {
  it("kind, rate and expiry, without the secret", () => {
    const { token, expiresAt } = mintDeskQrToken(EXH);
    expect(readDeskQrClaims(token)).toEqual({ kind: "exhibitor", rate: "inclusive", expiresAt: expiresAt.getTime() });
  });

  it("nothing for a missing or garbled token", () => {
    expect(readDeskQrClaims(null)).toBeNull();
    expect(readDeskQrClaims("%%%.x")).toBeNull();
  });

  it("the free kind too", () => {
    expect(readDeskQrClaims(mintDeskQrToken(FREE).token)).toMatchObject({ kind: "free", rate: "standard" });
  });
});

/**
 * Which rate a free-registration QR is for (docs/ONSITE_DESK_PLAN.md §10):
 * the one the public Register link lands on now, and only while it costs
 * nothing for every registration type.
 */
describe("the free rate", () => {
  const NOW = new Date("2026-11-11T08:00:00Z");
  const DAY = 86_400_000;
  type TierIn = Partial<FreeRateType["pricingTiers"][number]> & { name: string };
  const tier = (t: TierIn): FreeRateType["pricingTiers"][number] => ({
    price: 0, isActive: true, requiresApproval: false, quantity: 999999, soldCount: 0, salesStart: null, salesEnd: null, sortOrder: 0, ...t,
  });
  const type = (name: string, tiers: TierIn[], over: Partial<FreeRateType> = {}): FreeRateType => ({
    name, quantity: 999999, soldCount: 0, pricingTiers: tiers.map(tier), ...over,
  });
  const event = (ticketTypes: FreeRateType[], over: Record<string, unknown> = {}) => ({
    eventType: "CONFERENCE", registrationOpen: true, maxAttendees: null, seatCount: 0,
    mainRegisterTiers: undefined, codeRequiredTiers: [] as string[], ticketTypes, ...over,
  });
  const free = (ticketTypes: FreeRateType[], over: Record<string, unknown> = {}) => freeDeskRate(event(ticketTypes, over), NOW);

  // Production's free events: Standard on at 0 for every type, Early Bird and Onsite switched off.
  const FREE_EVENT = [
    type("Physician", [{ name: "Early Bird", isActive: false, sortOrder: 0 }, { name: "Standard", sortOrder: 1 }, { name: "Onsite", isActive: false, sortOrder: 2 }]),
    type("Nurse", [{ name: "Early Bird", isActive: false, sortOrder: 0 }, { name: "Standard", sortOrder: 1 }]),
  ];

  it("a free event: the rate on sale, free for every type", () => {
    expect(free(FREE_EVENT)).toEqual({ rateName: "Standard", slug: "standard", paidTypes: [] });
  });

  it("free for some types only: the rate, and the types it charges (no QR)", () => {
    // Production's MEHF 2027: Early Bird at 0 for Resident and Student, paid for the rest.
    const mixed = [
      type("Physician", [{ name: "Early Bird", price: 400 }]),
      type("Resident", [{ name: "Early Bird" }]),
      type("Allied Health", [{ name: "Early Bird", price: 150 }]),
    ];
    expect(free(mixed)).toEqual({ rateName: "Early Bird", slug: "early-bird", paidTypes: ["Physician", "Allied Health"] });
  });

  it("nothing on a paid event", () => {
    expect(free([type("Physician", [{ name: "Standard", price: 350 }])])).toBeNull();
  });

  it("never reopens a free Early Bird that gave way to a paid Standard: switched off, or past its sales end", () => {
    expect(free([type("Physician", [{ name: "Early Bird", isActive: false, sortOrder: 0 }, { name: "Standard", price: 350, sortOrder: 1 }])])).toBeNull();
    const ended = new Date(NOW.getTime() - DAY);
    expect(free([type("Physician", [{ name: "Early Bird", salesEnd: ended, sortOrder: 0 }, { name: "Standard", price: 350, sortOrder: 1 }])])).toBeNull();
    // And a free rate that closed with nothing after it: the public link is closed, so the QR is too.
    expect(free([type("Physician", [{ name: "Standard", salesEnd: ended }])])).toBeNull();
    expect(free([type("Physician", [{ name: "Standard", salesStart: new Date(NOW.getTime() + DAY) }])])).toBeNull();
  });

  it("follows the public Register link: registration off, a full event, or an unticked rate means no QR", () => {
    expect(free(FREE_EVENT, { registrationOpen: false })).toBeNull();
    expect(free(FREE_EVENT, { maxAttendees: 100, seatCount: 100 })).toBeNull();
    // Full on a hybrid event: the public link stays open for virtual, the desk is in person.
    expect(free(FREE_EVENT, { maxAttendees: 100, seatCount: 100, eventType: "HYBRID" })).toBeNull();
    expect(free(FREE_EVENT, { mainRegisterTiers: ["onsite"] })).toBeNull();
    expect(free([type("Physician", [{ name: "Workshop" }])])).toBeNull();
    expect(free([type("Physician", [{ name: "Workshop" }])], { mainRegisterTiers: ["workshop"] })).toMatchObject({ slug: "workshop", paidTypes: [] });
  });

  it("never the Complimentary rate (it has its own QR), a sponsor-code rate or a presenter rate", () => {
    expect(free([type("Physician", [{ name: "Complimentary" }])], { mainRegisterTiers: ["complimentary"] })).toBeNull();
    expect(free([type("Physician", [{ name: "Inclusive" }])], { mainRegisterTiers: ["inclusive"], codeRequiredTiers: ["inclusive"] })).toBeNull();
    expect(free([type("Physician", [{ name: "Presenter" }])], { mainRegisterTiers: ["presenter"] })).toBeNull();
  });

  it("the Exhibitor type is not on this QR: its price does not count, and it alone gives no QR", () => {
    const withExhibitor = [...FREE_EVENT, type("Exhibitor", [{ name: "Standard", price: 500, sortOrder: 1 }])];
    expect(free(withExhibitor)).toEqual({ rateName: "Standard", slug: "standard", paidTypes: [] });
    expect(free([type("Exhibitor", [{ name: "Standard" }])])).toBeNull();
  });

  it("a free rate nobody could use by QR gives none: approval needed, or no seats left", () => {
    expect(free([type("Physician", [{ name: "Standard", requiresApproval: true }])])).toBeNull();
    expect(free([type("Physician", [{ name: "Standard", quantity: 10, soldCount: 10 }])])).toBeNull();
    expect(free([type("Physician", [{ name: "Standard" }], { quantity: 5, soldCount: 5 })])).toBeNull();
    // One type full, another open: still a QR, for the open one.
    expect(free([type("Physician", [{ name: "Standard" }], { quantity: 5, soldCount: 5 }), type("Nurse", [{ name: "Standard" }])])).toMatchObject({ paidTypes: [] });
  });

  it("a price that is not a number counts as paid", () => {
    expect(free([type("Physician", [{ name: "Standard", price: Number.NaN }]), type("Nurse", [{ name: "Standard" }])])).toMatchObject({ paidTypes: ["Physician"] });
  });
});
