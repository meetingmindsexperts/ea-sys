/**
 * The desk QR token and its rules (docs/ONSITE_DESK_PLAN.md §8.4, §8.5).
 */
import { describe, it, expect } from "vitest";

process.env.NEXTAUTH_SECRET = "test-secret-for-desk-qr";

import { mintDeskQrToken, verifyDeskQrToken, DESK_QR_TTL_SECONDS, type DeskQrSubject } from "@/lib/desk-qr-token";
import { deskQrPriceRefusal, deskQrTypeRefusal, readDeskQrClaims } from "@/lib/desk-qr-rules";

const COMP: DeskQrSubject = { eventId: "evt-1", kind: "complimentary", rate: "complimentary", promoCodeId: null, issuedBy: "staff-1" };
const EXH: DeskQrSubject = { eventId: "evt-1", kind: "exhibitor", rate: "inclusive", promoCodeId: null, issuedBy: "desk" };

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
});
