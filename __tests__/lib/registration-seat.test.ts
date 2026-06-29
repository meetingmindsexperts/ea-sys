/**
 * Seat-accounting model — hybrid attendance soldCount + qrCode correctness AND
 * the PricingTier-vs-TicketType counter routing (ROADMAP P1.1 double-leak fix).
 */
import { describe, it, expect } from "vitest";
import {
  holdsSeat,
  seatCounter,
  planSeatTransition,
  needsQrCode,
  type SeatState,
} from "@/lib/registration-seat";

const IN = "IN_PERSON" as const;
const VI = "VIRTUAL" as const;
const T = "tt_1";
const T2 = "tt_2";
const P = "pt_1";

// Concise SeatState builder. Defaults model an ADMIN/no-tier registration
// (counts on the ticket-type counter); pass createdSource/pricingTierId to model
// the public-register + tier case.
function s(
  status: SeatState["status"],
  attendanceMode: SeatState["attendanceMode"],
  ticketTypeId: string | null,
  opts: { pricingTierId?: string | null; createdSource?: SeatState["createdSource"] } = {},
): SeatState {
  return {
    status,
    attendanceMode,
    ticketTypeId,
    pricingTierId: opts.pricingTierId ?? null,
    createdSource: opts.createdSource ?? "ADMIN_DASHBOARD",
  };
}

const TT = (id: string) => ({ kind: "ticketType" as const, id });
const TIER = (id: string) => ({ kind: "tier" as const, id });

describe("holdsSeat", () => {
  it("only an in-person, non-cancelled registration holds a seat", () => {
    expect(holdsSeat("CONFIRMED", IN)).toBe(true);
    expect(holdsSeat("PENDING", IN)).toBe(true);
    expect(holdsSeat("CONFIRMED", VI)).toBe(false); // virtual = uncapped
    expect(holdsSeat("CANCELLED", IN)).toBe(false); // cancelled holds nothing
    expect(holdsSeat("CANCELLED", VI)).toBe(false);
  });
});

describe("seatCounter — which counter the seat is tallied on", () => {
  it("public register + tier → the TIER counter", () => {
    expect(seatCounter({ createdSource: "PUBLIC_REGISTER", pricingTierId: P, ticketTypeId: T })).toEqual(TIER(P));
  });
  it("admin/service + tier → the TICKET-TYPE counter (admin path never bumps the tier)", () => {
    expect(seatCounter({ createdSource: "ADMIN_DASHBOARD", pricingTierId: P, ticketTypeId: T })).toEqual(TT(T));
    expect(seatCounter({ createdSource: "MCP_AGENT", pricingTierId: P, ticketTypeId: T })).toEqual(TT(T));
  });
  it("public register WITHOUT a tier → the TICKET-TYPE counter", () => {
    expect(seatCounter({ createdSource: "PUBLIC_REGISTER", pricingTierId: null, ticketTypeId: T })).toEqual(TT(T));
  });
  it("no ticket type → null (nothing to count)", () => {
    expect(seatCounter({ createdSource: "PUBLIC_REGISTER", pricingTierId: null, ticketTypeId: null })).toBeNull();
  });
  it("speaker companion (faculty) → null — uncapped, never counts on any counter", () => {
    expect(seatCounter({ createdSource: "SPEAKER_COMPANION", pricingTierId: null, ticketTypeId: "faculty_tt" })).toBeNull();
    // even if a tier id were somehow set, a companion still counts on nothing
    expect(seatCounter({ createdSource: "SPEAKER_COMPANION", pricingTierId: "pt", ticketTypeId: "faculty_tt" })).toBeNull();
  });
});

describe("planSeatTransition — ticket-type axis (hybrid)", () => {
  it("virtual → in-person: claims a seat (the primary hybrid gap)", () => {
    expect(planSeatTransition(s("CONFIRMED", VI, T), s("CONFIRMED", IN, T))).toEqual({ release: null, claim: TT(T) });
  });
  it("in-person → virtual: releases the seat", () => {
    expect(planSeatTransition(s("CONFIRMED", IN, T), s("CONFIRMED", VI, T))).toEqual({ release: TT(T), claim: null });
  });
  it("cancelling an in-person reg releases its seat", () => {
    expect(planSeatTransition(s("CONFIRMED", IN, T), s("CANCELLED", IN, T))).toEqual({ release: TT(T), claim: null });
  });
  it("cancelling a VIRTUAL reg is a no-op (never held a seat)", () => {
    expect(planSeatTransition(s("CONFIRMED", VI, T), s("CANCELLED", VI, T))).toEqual({ release: null, claim: null });
  });
  it("reactivating to in-person claims a seat", () => {
    expect(planSeatTransition(s("CANCELLED", IN, T), s("CONFIRMED", IN, T))).toEqual({ release: null, claim: TT(T) });
  });
  it("type change while in-person: release old, claim new", () => {
    expect(planSeatTransition(s("CONFIRMED", IN, T), s("CONFIRMED", IN, T2))).toEqual({ release: TT(T), claim: TT(T2) });
  });
  it("no change is a no-op", () => {
    expect(planSeatTransition(s("CONFIRMED", IN, T), s("CONFIRMED", IN, T))).toEqual({ release: null, claim: null });
  });
  it("missing ticketTypeId never holds a seat", () => {
    expect(planSeatTransition(s("CONFIRMED", IN, null), s("CONFIRMED", IN, null))).toEqual({ release: null, claim: null });
  });
});

describe("planSeatTransition — tier axis (P1.1 double-leak fix)", () => {
  const pub = { createdSource: "PUBLIC_REGISTER" as const, pricingTierId: P };

  it("cancelling a PUBLIC+TIER reg releases the TIER, never the ticket type", () => {
    expect(
      planSeatTransition(s("CONFIRMED", IN, T, pub), s("CANCELLED", IN, T, pub)),
    ).toEqual({ release: TIER(P), claim: null });
  });

  it("cancelling an ADMIN+TIER reg releases the TICKET TYPE (admin tier counts on the type)", () => {
    expect(
      planSeatTransition(
        s("CONFIRMED", IN, T, { createdSource: "ADMIN_DASHBOARD", pricingTierId: P }),
        s("CANCELLED", IN, T, { createdSource: "ADMIN_DASHBOARD", pricingTierId: P }),
      ),
    ).toEqual({ release: TT(T), claim: null });
  });

  it("reactivating a PUBLIC+TIER reg re-claims the TIER", () => {
    expect(
      planSeatTransition(s("CANCELLED", IN, T, pub), s("CONFIRMED", IN, T, pub)),
    ).toEqual({ release: null, claim: TIER(P) });
  });

  it("type-change of a PUBLIC+TIER reg (caller nulls next tier) → release TIER, claim new TICKET TYPE", () => {
    // The wiring sites pass next.pricingTierId = null on a type change; the old
    // tier belongs to the old type so the seat moves to the new ticket-type.
    expect(
      planSeatTransition(
        s("CONFIRMED", IN, T, pub),
        s("CONFIRMED", IN, T2, { createdSource: "PUBLIC_REGISTER", pricingTierId: null }),
      ),
    ).toEqual({ release: TIER(P), claim: TT(T2) });
  });

  it("PUBLIC+TIER no-op (same tier, still active) moves nothing", () => {
    expect(
      planSeatTransition(s("CONFIRMED", IN, T, pub), s("CONFIRMED", IN, T, pub)),
    ).toEqual({ release: null, claim: null });
  });

  it("PUBLIC+TIER going virtual releases the TIER (virtual is uncapped)", () => {
    expect(
      planSeatTransition(s("CONFIRMED", IN, T, pub), s("CONFIRMED", VI, T, pub)),
    ).toEqual({ release: TIER(P), claim: null });
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
