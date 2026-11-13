/**
 * What a badge print left out (owner, Nov 13, 2026): the counts the badge
 * route sends with its PDF, and the words the Badges dialog shows for them.
 */
import { describe, it, expect } from "vitest";
import {
  BADGES_NO_BADGE_HEADER,
  BADGES_PAYMENT_DUE_HEADER,
  BADGES_PAYMENT_DUE_NUMBERS_HEADER,
  BADGES_PRINTED_HEADER,
  MAX_LEFT_OUT_NUMBERS,
  badgeLeftOutMessage,
  badgePrintHeaders,
  badgeRefusal,
  readBadgePrintResult,
} from "@/lib/badge-print-result";

const headersOf = (map: Record<string, string>) => ({ get: (name: string) => map[name] ?? null });
const roundTrip = (printed: number, leftOut: { serialId: number | null }[], noBadge = 0) =>
  readBadgePrintResult(headersOf(badgePrintHeaders(printed, leftOut, noBadge)));

describe("badgePrintHeaders and readBadgePrintResult", () => {
  it("nobody left out: the count is 0 and no numbers header is sent", () => {
    const headers = badgePrintHeaders(12, []);
    expect(headers).toEqual({ [BADGES_PRINTED_HEADER]: "12", [BADGES_PAYMENT_DUE_HEADER]: "0", [BADGES_NO_BADGE_HEADER]: "0" });
    expect(readBadgePrintResult(headersOf(headers))).toEqual({ printed: 12, paymentDue: 0, paymentDueNumbers: [], noBadge: 0 });
  });

  it("names the registration numbers as the list prints them, lowest first", () => {
    const result = roundTrip(47, [{ serialId: 76 }, { serialId: 9 }, { serialId: 120 }]);
    expect(result).toEqual({ printed: 47, paymentDue: 3, paymentDueNumbers: ["009", "076", "120"], noBadge: 0 });
  });

  it("counts a row with no number without naming it", () => {
    expect(roundTrip(1, [{ serialId: null }, { serialId: 4 }])).toEqual({ printed: 1, paymentDue: 2, paymentDueNumbers: ["004"], noBadge: 0 });
  });

  it("carries the others with no badge as a count of its own, never below zero", () => {
    expect(roundTrip(46, [{ serialId: 69 }], 3)).toEqual({ printed: 46, paymentDue: 1, paymentDueNumbers: ["069"], noBadge: 3 });
    expect(roundTrip(5, [], -2).noBadge).toBe(0);
  });

  it("caps the numbers, never the count", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ serialId: i + 1 }));
    const headers = badgePrintHeaders(5, many);
    expect(headers[BADGES_PAYMENT_DUE_HEADER]).toBe("60");
    expect(headers[BADGES_PAYMENT_DUE_NUMBERS_HEADER].split(",")).toHaveLength(MAX_LEFT_OUT_NUMBERS);
    expect(headers[BADGES_PAYMENT_DUE_NUMBERS_HEADER].length).toBeLessThan(200);
  });

  it("missing or malformed headers read as nothing left out (an older server mid-deploy)", () => {
    expect(readBadgePrintResult(headersOf({}))).toEqual({ printed: null, paymentDue: 0, paymentDueNumbers: [], noBadge: 0 });
    const junk = headersOf({
      [BADGES_PRINTED_HEADER]: "many",
      [BADGES_PAYMENT_DUE_HEADER]: "-3",
      [BADGES_PAYMENT_DUE_NUMBERS_HEADER]: "<b>1</b>, 007 ,x",
      [BADGES_NO_BADGE_HEADER]: "a few",
    });
    expect(readBadgePrintResult(junk)).toEqual({ printed: null, paymentDue: 0, paymentDueNumbers: ["007"], noBadge: 0 });
  });
});

describe("badgeLeftOutMessage", () => {
  it("is null when nobody was left out, so the screen keeps its usual words", () => {
    expect(badgeLeftOutMessage({ printed: 12, paymentDue: 0, paymentDueNumbers: [], noBadge: 0 })).toBeNull();
  });

  it("says how many printed, how many were left out, which, and what to do", () => {
    expect(badgeLeftOutMessage({ printed: 47, paymentDue: 3, paymentDueNumbers: ["069", "071", "076"], noBadge: 0 })).toBe(
      "47 badges ready to print. 3 left out, payment due: 069, 071, 076. Record the payment or set them to Complimentary, then print those.",
    );
  });

  it("one of each reads in the singular", () => {
    expect(badgeLeftOutMessage({ printed: 1, paymentDue: 1, paymentDueNumbers: ["076"], noBadge: 0 })).toBe(
      "1 badge ready to print. 1 left out, payment due: 076. Record the payment or set it to Complimentary, then print that one.",
    );
  });

  it("past the cap it names the first and counts the rest", () => {
    const message = badgeLeftOutMessage({ printed: 5, paymentDue: 23, paymentDueNumbers: ["001", "002"], noBadge: 0 });
    expect(message).toContain("23 left out, payment due: 001, 002 and 21 more.");
  });

  it("others with no badge are counted without the payment remedy (review of b19e5e44)", () => {
    // A cancelled or virtual row in the selection: never "record the payment".
    expect(badgeLeftOutMessage({ printed: 47, paymentDue: 0, paymentDueNumbers: [], noBadge: 3 })).toBe(
      "47 badges ready to print. 3 in the selection get no badge (virtual, cancelled or refunded).",
    );
    expect(badgeLeftOutMessage({ printed: 1, paymentDue: 0, paymentDueNumbers: [], noBadge: 1 })).toBe(
      "1 badge ready to print. 1 in the selection gets no badge (virtual, cancelled or refunded).",
    );
  });

  it("with both, the figures add up to the selection: 46 + 1 + 3 of 50", () => {
    expect(badgeLeftOutMessage({ printed: 46, paymentDue: 1, paymentDueNumbers: ["069"], noBadge: 3 })).toBe(
      "46 badges ready to print. 1 left out, payment due: 069. Record the payment or set it to Complimentary, then print that one. 3 others in the selection get no badge (virtual, cancelled or refunded).",
    );
  });

  it("still warns when the numbers or the printed count are unknown", () => {
    expect(badgeLeftOutMessage({ printed: null, paymentDue: 2, paymentDueNumbers: [], noBadge: 0 })).toBe(
      "Badges ready to print. 2 left out, payment due. Record the payment or set them to Complimentary, then print those.",
    );
  });
});

describe("badgeRefusal: nothing was printed, and the reason is the true one", () => {
  it("nothing asked for and nothing matched (Print All on an empty event)", () => {
    expect(badgeRefusal({ asked: 0, matched: 0, paymentDue: 0, cancelled: 0 })).toEqual({
      error: "No registrations matched. Check the selection and try again.",
      code: "BADGE_NO_MATCH",
    });
  });

  it("asked for by id and none came back: virtual, or gone since the list loaded", () => {
    expect(badgeRefusal({ asked: 2, matched: 0, paymentDue: 0, cancelled: 0 })).toEqual({
      error: "Nothing to print: the selection is virtual, or no longer on this event.",
      code: "BADGE_NO_MATCH",
    });
  });

  it("one person who owes: the remedy, as before", () => {
    const refusal = badgeRefusal({ asked: 1, matched: 1, paymentDue: 1, cancelled: 0 });
    expect(refusal).toMatchObject({ code: "BADGE_PAYMENT_REQUIRED", blocked: 1 });
    expect(refusal.error).toContain("still owes payment");
  });

  it("a cancelled registration is never told to record a payment (owner, Nov 13, 2026)", () => {
    expect(badgeRefusal({ asked: 1, matched: 1, paymentDue: 0, cancelled: 1 })).toEqual({
      error: "This registration is cancelled, so it has no badge.",
      code: "BADGE_NOT_AVAILABLE",
    });
    expect(badgeRefusal({ asked: 3, matched: 3, paymentDue: 0, cancelled: 2 })).toEqual({
      error: "None of the 3 selected registrations can have a badge: they are virtual, cancelled or refunded.",
      code: "BADGE_NOT_AVAILABLE",
    });
  });

  it("counts the selection, not what the query matched (review of d8552af9)", () => {
    // "Print 3 Selected": one virtual (the query drops it) and two cancelled.
    expect(badgeRefusal({ asked: 3, matched: 2, paymentDue: 0, cancelled: 2 }).error).toBe(
      "None of the 3 selected registrations can have a badge: they are virtual, cancelled or refunded.",
    );
    // Two selected, one virtual and one cancelled: not the singular "This registration".
    expect(badgeRefusal({ asked: 2, matched: 1, paymentDue: 0, cancelled: 1 }).error).toBe(
      "None of the 2 selected registrations can have a badge: they are virtual, cancelled or refunded.",
    );
    // One owing and one virtual: the owing one is not "This registration" either.
    expect(badgeRefusal({ asked: 2, matched: 1, paymentDue: 1, cancelled: 0 })).toMatchObject({ blocked: 1 });
    expect(badgeRefusal({ asked: 2, matched: 1, paymentDue: 1, cancelled: 0 }).error).toContain("None of the 2 selected");
  });

  it("refunded and not cancelled: its place no longer stands", () => {
    expect(badgeRefusal({ asked: 1, matched: 1, paymentDue: 0, cancelled: 0 }).error).toBe(
      "This registration was refunded and its place no longer stands, so it has no badge.",
    );
  });

  it("several, some owing and some not: only the owing are blocked, and only they get the remedy", () => {
    expect(badgeRefusal({ asked: 5, matched: 5, paymentDue: 3, cancelled: 2 })).toEqual({
      error:
        "None of the 5 selected registrations can be badged: 3 still owe payment (unpaid or pending). Record the payment, or set them to Complimentary, then print. The other 2 get no badge (virtual, cancelled or refunded).",
      code: "BADGE_PAYMENT_REQUIRED",
      blocked: 3,
    });
    // One owing beside one cancelled: "that registration", never "them".
    expect(badgeRefusal({ asked: 2, matched: 2, paymentDue: 1, cancelled: 1 }).error).toBe(
      "None of the 2 selected registrations can be badged: 1 still owes payment (unpaid or pending). Record that payment, or set that registration to Complimentary, then print. The other one gets no badge (virtual, cancelled or refunded).",
    );
    expect(badgeRefusal({ asked: 2, matched: 2, paymentDue: 2, cancelled: 0 }).error).toBe(
      "None of the 2 selected registrations can be badged: 2 still owe payment (unpaid or pending). Record the payment, or set them to Complimentary, then print.",
    );
  });
});
