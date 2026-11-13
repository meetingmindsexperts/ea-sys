/**
 * What a badge print left out (owner, Nov 13, 2026): the counts the badge
 * route sends with its PDF, and the words the Badges dialog shows for them.
 */
import { describe, it, expect } from "vitest";
import {
  BADGES_PAYMENT_DUE_HEADER,
  BADGES_PAYMENT_DUE_NUMBERS_HEADER,
  BADGES_PRINTED_HEADER,
  MAX_LEFT_OUT_NUMBERS,
  badgeLeftOutMessage,
  badgePrintHeaders,
  readBadgePrintResult,
} from "@/lib/badge-print-result";

const headersOf = (map: Record<string, string>) => ({ get: (name: string) => map[name] ?? null });
const roundTrip = (printed: number, leftOut: { serialId: number | null }[]) =>
  readBadgePrintResult(headersOf(badgePrintHeaders(printed, leftOut)));

describe("badgePrintHeaders and readBadgePrintResult", () => {
  it("nobody left out: the count is 0 and no numbers header is sent", () => {
    const headers = badgePrintHeaders(12, []);
    expect(headers).toEqual({ [BADGES_PRINTED_HEADER]: "12", [BADGES_PAYMENT_DUE_HEADER]: "0" });
    expect(readBadgePrintResult(headersOf(headers))).toEqual({ printed: 12, paymentDue: 0, paymentDueNumbers: [] });
  });

  it("names the registration numbers as the list prints them, lowest first", () => {
    const result = roundTrip(47, [{ serialId: 76 }, { serialId: 9 }, { serialId: 120 }]);
    expect(result).toEqual({ printed: 47, paymentDue: 3, paymentDueNumbers: ["009", "076", "120"] });
  });

  it("counts a row with no number without naming it", () => {
    expect(roundTrip(1, [{ serialId: null }, { serialId: 4 }])).toEqual({ printed: 1, paymentDue: 2, paymentDueNumbers: ["004"] });
  });

  it("caps the numbers, never the count", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ serialId: i + 1 }));
    const headers = badgePrintHeaders(5, many);
    expect(headers[BADGES_PAYMENT_DUE_HEADER]).toBe("60");
    expect(headers[BADGES_PAYMENT_DUE_NUMBERS_HEADER].split(",")).toHaveLength(MAX_LEFT_OUT_NUMBERS);
    expect(headers[BADGES_PAYMENT_DUE_NUMBERS_HEADER].length).toBeLessThan(200);
  });

  it("missing or malformed headers read as nothing left out (an older server mid-deploy)", () => {
    expect(readBadgePrintResult(headersOf({}))).toEqual({ printed: null, paymentDue: 0, paymentDueNumbers: [] });
    const junk = headersOf({
      [BADGES_PRINTED_HEADER]: "many",
      [BADGES_PAYMENT_DUE_HEADER]: "-3",
      [BADGES_PAYMENT_DUE_NUMBERS_HEADER]: "<b>1</b>, 007 ,x",
    });
    expect(readBadgePrintResult(junk)).toEqual({ printed: null, paymentDue: 0, paymentDueNumbers: ["007"] });
  });
});

describe("badgeLeftOutMessage", () => {
  it("is null when nobody was left out, so the screen keeps its usual words", () => {
    expect(badgeLeftOutMessage({ printed: 12, paymentDue: 0, paymentDueNumbers: [] })).toBeNull();
  });

  it("says how many printed, how many were left out, which, and what to do", () => {
    expect(badgeLeftOutMessage({ printed: 47, paymentDue: 3, paymentDueNumbers: ["069", "071", "076"] })).toBe(
      "47 badges ready to print. 3 left out, payment due: 069, 071, 076. Record the payment or set them to Complimentary, then print those.",
    );
  });

  it("one of each reads in the singular", () => {
    expect(badgeLeftOutMessage({ printed: 1, paymentDue: 1, paymentDueNumbers: ["076"] })).toBe(
      "1 badge ready to print. 1 left out, payment due: 076. Record the payment or set it to Complimentary, then print that one.",
    );
  });

  it("past the cap it names the first and counts the rest", () => {
    const message = badgeLeftOutMessage({ printed: 5, paymentDue: 23, paymentDueNumbers: ["001", "002"] });
    expect(message).toContain("23 left out, payment due: 001, 002 and 21 more.");
  });

  it("still warns when the numbers or the printed count are unknown", () => {
    expect(badgeLeftOutMessage({ printed: null, paymentDue: 2, paymentDueNumbers: [] })).toBe(
      "Badges ready to print. 2 left out, payment due. Record the payment or set them to Complimentary, then print those.",
    );
  });
});
