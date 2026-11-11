/**
 * DTCM codes at the onsite desk (docs/DTCM_ETICKET_PLAN.md §5.4): which rows
 * the desk flags, what a walk-in's answer says about its code, and what staff
 * are told when nothing can issue one. The buying and the pool have their own
 * tests (dtcm-eticket-*, dtcm-pool); these are the desk's decisions.
 */
import { describe, it, expect } from "vitest";
import { deskDetState, deskDtcmNoSourceMessage, deskMayOfferSpare, deskRowNeedsDtcmCode, walkInDtcmWarning, walkInLeftWithoutDtcmCode } from "@/lib/desk-dtcm";
import { lacksDtcmCode } from "@/lib/dtcm-walkup";

const DUBAI = { requiresDtcm: true, canSeeCodes: true };
const row = (over: Record<string, unknown> = {}) => ({ status: "CONFIRMED", attendanceMode: "IN_PERSON", dtcmBarcode: null as string | null, ...over });

describe("which rows the desk flags", () => {
  it("an in-person registration on a Dubai event with no code, checked in or not", () => {
    expect(deskRowNeedsDtcmCode(DUBAI, row())).toBe(true);
    expect(deskRowNeedsDtcmCode(DUBAI, row({ status: "CHECKED_IN" }))).toBe(true);
    expect(deskRowNeedsDtcmCode(DUBAI, row({ status: "PENDING" }))).toBe(true);
  });

  it("not one that has a code, and never on an event without DTCM", () => {
    expect(deskRowNeedsDtcmCode(DUBAI, row({ dtcmBarcode: "9f2c-uuid" }))).toBe(false);
    expect(deskRowNeedsDtcmCode({ requiresDtcm: false, canSeeCodes: true }, row())).toBe(false);
  });

  it("not a virtual attendee, a cancelled one or one on the waitlist", () => {
    expect(deskRowNeedsDtcmCode(DUBAI, row({ attendanceMode: "VIRTUAL" }))).toBe(false);
    expect(deskRowNeedsDtcmCode(DUBAI, row({ status: "CANCELLED" }))).toBe(false);
    expect(deskRowNeedsDtcmCode(DUBAI, row({ status: "WAITLISTED" }))).toBe(false);
  });

  it("never for a role that cannot see codes: its rows have the key stripped, so every one would read as missing", () => {
    // What the list hands a MEMBER: no `dtcmBarcode` key at all, code or not.
    const stripped = { status: "CONFIRMED", attendanceMode: "IN_PERSON" };
    expect(deskRowNeedsDtcmCode({ requiresDtcm: true, canSeeCodes: false }, stripped)).toBe(false);
    // The same row for someone who can see codes really does lack one.
    expect(deskRowNeedsDtcmCode(DUBAI, stripped)).toBe(true);
  });

  it("is the walk-up warning's own condition", () => {
    for (const facts of [
      { requiresDtcm: true, attendanceMode: "IN_PERSON", dtcmBarcode: null },
      { requiresDtcm: true, attendanceMode: "VIRTUAL", dtcmBarcode: null },
      { requiresDtcm: true, attendanceMode: "IN_PERSON", dtcmBarcode: "x" },
      { requiresDtcm: false, attendanceMode: "IN_PERSON", dtcmBarcode: null },
    ]) {
      expect(deskRowNeedsDtcmCode({ requiresDtcm: facts.requiresDtcm, canSeeCodes: true }, { status: "CONFIRMED", ...facts })).toBe(lacksDtcmCode(facts));
    }
  });
});

describe("a walk-in's answer", () => {
  it("left without a code when the pool was empty or the claim failed", () => {
    expect(walkInLeftWithoutDtcmCode(true, { status: "pool-empty" })).toBe(true);
    expect(walkInLeftWithoutDtcmCode(true, { status: "failed" })).toBe(true);
  });

  it("not when a spare was assigned, or none was needed", () => {
    expect(walkInLeftWithoutDtcmCode(true, { status: "assigned", code: "9f2c" })).toBe(false);
    expect(walkInLeftWithoutDtcmCode(true, { status: "already-has-code", code: "9f2c" })).toBe(false);
    expect(walkInLeftWithoutDtcmCode(true, { status: "not-applicable" })).toBe(false);
  });

  it("silent on an event without DTCM, and when the answer carries no outcome", () => {
    expect(walkInLeftWithoutDtcmCode(false, { status: "pool-empty" })).toBe(false);
    expect(walkInLeftWithoutDtcmCode(true, undefined)).toBe(false);
    expect(walkInLeftWithoutDtcmCode(true, null)).toBe(false);
    expect(walkInLeftWithoutDtcmCode(true, "pool-empty")).toBe(false);
  });

  it("names the person, the consequence and who can put it right", () => {
    const fixable = walkInDtcmWarning("Dr. Hajar Almaqbali", true);
    expect(fixable).toContain("Dr. Hajar Almaqbali has no DTCM code yet");
    expect(fixable).toContain("no compliance QR");
    expect(fixable).toContain("on their row");
    expect(walkInDtcmWarning("Dr. Hajar Almaqbali", false)).toContain("Ask an organiser");
  });
});

const order = (status: string, unresolved = false) => ({ status, unresolved });

describe("where a person stands with DET", () => {
  it("nothing live: no orders, or only ones that failed or were reversed", () => {
    expect(deskDetState([])).toBe("none");
    expect(deskDetState([order("FAILED"), order("REVERSED")])).toBe("none");
  });

  it("buying: a fresh PENDING order, whoever pressed", () => {
    expect(deskDetState([order("PENDING")])).toBe("buying");
    // It wins over an older order that needs a person: the first thing to say is "wait".
    expect(deskDetState([order("UNCERTAIN", true), order("PENDING")])).toBe("buying");
  });

  it("attention: an uncertain sale, a PENDING left by a crash, or a ticket sold whose code is not on the row", () => {
    expect(deskDetState([order("UNCERTAIN", true)])).toBe("attention");
    expect(deskDetState([order("PENDING", true)])).toBe("attention");
    expect(deskDetState([order("PURCHASED")])).toBe("attention");
    expect(deskDetState([order("REVERSED"), order("PURCHASED")])).toBe("attention");
  });
});

describe("when the desk may offer a spare code", () => {
  const ok = { detKnown: true, detState: "none" as const, buyingHere: false, spare: 2 };

  it("the pool has one and DET has nothing live for this person", () => {
    expect(deskMayOfferSpare(ok)).toBe(true);
    expect(deskMayOfferSpare({ ...ok, spare: 0 })).toBe(false);
  });

  // The HIGH of the review: a spare taken beside a purchase leaves a bought ticket nobody holds.
  it("never while a DET purchase is in flight, pressed here or seen at DET", () => {
    expect(deskMayOfferSpare({ ...ok, buyingHere: true })).toBe(false);
    expect(deskMayOfferSpare({ ...ok, detState: "buying" })).toBe(false);
  });

  it("never beside a sale that needs an organiser: the purchase route leaves that decision to them", () => {
    expect(deskMayOfferSpare({ ...ok, detState: "attention" })).toBe(false);
  });

  it("never before the DET read has answered: not knowing is not 'nothing live'", () => {
    expect(deskMayOfferSpare({ ...ok, detKnown: false })).toBe(false);
  });
});

describe("when nothing can issue a code", () => {
  it("says so, without blaming one cause, and sends the desk to an organiser", () => {
    const message = deskDtcmNoSourceMessage({ detReady: false, detState: "none", spare: 0 });
    expect(message).toContain("no spare codes");
    expect(message).toContain("Ask an organiser");
    // DET can be unready for reasons other than the type's mapping (no credentials, a stale mapping).
    expect(message).toContain("not set up for this event, or this registration type has no DET section");
  });

  it("stays quiet while the desk has something to press or read", () => {
    expect(deskDtcmNoSourceMessage({ detReady: true, detState: "none", spare: 0 })).toBeNull();
    expect(deskDtcmNoSourceMessage({ detReady: false, detState: "none", spare: 3 })).toBeNull();
    // DET cannot sell now, but a sale of theirs is live or waiting on someone: the panel shows that instead.
    expect(deskDtcmNoSourceMessage({ detReady: false, detState: "attention", spare: 0 })).toBeNull();
    expect(deskDtcmNoSourceMessage({ detReady: false, detState: "buying", spare: 0 })).toBeNull();
  });
});
