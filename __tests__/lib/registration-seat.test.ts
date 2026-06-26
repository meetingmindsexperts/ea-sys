/**
 * Seat-accounting model — hybrid attendance soldCount + qrCode correctness.
 */
import { describe, it, expect } from "vitest";
import { holdsSeat, planSeatTransition, needsQrCode } from "@/lib/registration-seat";

const IN = "IN_PERSON" as const;
const VI = "VIRTUAL" as const;

describe("holdsSeat", () => {
  it("only an in-person, non-cancelled registration holds a seat", () => {
    expect(holdsSeat("CONFIRMED", IN)).toBe(true);
    expect(holdsSeat("PENDING", IN)).toBe(true);
    expect(holdsSeat("CONFIRMED", VI)).toBe(false); // virtual = uncapped
    expect(holdsSeat("CANCELLED", IN)).toBe(false); // cancelled holds nothing
    expect(holdsSeat("CANCELLED", VI)).toBe(false);
  });
});

describe("planSeatTransition", () => {
  const T = "tt_1";
  const T2 = "tt_2";

  it("virtual → in-person: claims a seat (the primary gap)", () => {
    expect(
      planSeatTransition(
        { status: "CONFIRMED", attendanceMode: VI, ticketTypeId: T },
        { status: "CONFIRMED", attendanceMode: IN, ticketTypeId: T },
      ),
    ).toEqual({ release: null, claim: T });
  });

  it("in-person → virtual: releases the seat", () => {
    expect(
      planSeatTransition(
        { status: "CONFIRMED", attendanceMode: IN, ticketTypeId: T },
        { status: "CONFIRMED", attendanceMode: VI, ticketTypeId: T },
      ),
    ).toEqual({ release: T, claim: null });
  });

  it("cancelling an in-person reg releases its seat", () => {
    expect(
      planSeatTransition(
        { status: "CONFIRMED", attendanceMode: IN, ticketTypeId: T },
        { status: "CANCELLED", attendanceMode: IN, ticketTypeId: T },
      ),
    ).toEqual({ release: T, claim: null });
  });

  it("cancelling a VIRTUAL reg is a no-op (it never held a seat — fixes the latent bug)", () => {
    expect(
      planSeatTransition(
        { status: "CONFIRMED", attendanceMode: VI, ticketTypeId: T },
        { status: "CANCELLED", attendanceMode: VI, ticketTypeId: T },
      ),
    ).toEqual({ release: null, claim: null });
  });

  it("reactivating to in-person claims a seat", () => {
    expect(
      planSeatTransition(
        { status: "CANCELLED", attendanceMode: IN, ticketTypeId: T },
        { status: "CONFIRMED", attendanceMode: IN, ticketTypeId: T },
      ),
    ).toEqual({ release: null, claim: T });
  });

  it("reactivating a VIRTUAL reg is a no-op", () => {
    expect(
      planSeatTransition(
        { status: "CANCELLED", attendanceMode: VI, ticketTypeId: T },
        { status: "CONFIRMED", attendanceMode: VI, ticketTypeId: T },
      ),
    ).toEqual({ release: null, claim: null });
  });

  it("type change while in-person: release old, claim new", () => {
    expect(
      planSeatTransition(
        { status: "CONFIRMED", attendanceMode: IN, ticketTypeId: T },
        { status: "CONFIRMED", attendanceMode: IN, ticketTypeId: T2 },
      ),
    ).toEqual({ release: T, claim: T2 });
  });

  it("type change while virtual: no seat movement on either type", () => {
    expect(
      planSeatTransition(
        { status: "CONFIRMED", attendanceMode: VI, ticketTypeId: T },
        { status: "CONFIRMED", attendanceMode: VI, ticketTypeId: T2 },
      ),
    ).toEqual({ release: null, claim: null });
  });

  it("combined type-change + virtual→in-person: release nothing (was virtual), claim the new type", () => {
    expect(
      planSeatTransition(
        { status: "CONFIRMED", attendanceMode: VI, ticketTypeId: T },
        { status: "CONFIRMED", attendanceMode: IN, ticketTypeId: T2 },
      ),
    ).toEqual({ release: null, claim: T2 });
  });

  it("no change (same seat, same type) is a no-op", () => {
    expect(
      planSeatTransition(
        { status: "CONFIRMED", attendanceMode: IN, ticketTypeId: T },
        { status: "CONFIRMED", attendanceMode: IN, ticketTypeId: T },
      ),
    ).toEqual({ release: null, claim: null });
  });

  it("missing ticketTypeId never holds a seat", () => {
    expect(
      planSeatTransition(
        { status: "CONFIRMED", attendanceMode: IN, ticketTypeId: null },
        { status: "CONFIRMED", attendanceMode: IN, ticketTypeId: null },
      ),
    ).toEqual({ release: null, claim: null });
  });
});

describe("needsQrCode", () => {
  it("mints when becoming in-person with no existing barcode", () => {
    expect(needsQrCode(IN, null)).toBe(true);
    expect(needsQrCode(IN, "")).toBe(true);
  });
  it("keeps an existing barcode (no re-mint)", () => {
    expect(needsQrCode(IN, "BC-123")).toBe(false);
  });
  it("never mints for virtual", () => {
    expect(needsQrCode(VI, null)).toBe(false);
    expect(needsQrCode(VI, "BC-123")).toBe(false);
  });
});
