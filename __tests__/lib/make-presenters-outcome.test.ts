/** What "make the registration Complimentary now" came to, in the page's words (Nov 20, 2026; plan step 4). */
import { describe, it, expect } from "vitest";
import { describeMakePresenters, makePresentersNeedsAttention, type MakePresentersOutcome } from "@/lib/make-presenters-outcome";

const NONE: MakePresentersOutcome = { made: [], already: [], skipped: [], noRegistration: [], notAccepted: [], remaining: [] };
const numberOf = (id: string) => `A-${id}`;

describe("describeMakePresenters", () => {
  it("counts the authors made presenters, once each, and asks for nothing more", () => {
    const outcome = { ...NONE, made: ["1", "2", "2"] };
    expect(describeMakePresenters(outcome, numberOf)).toEqual(["Presenters: 2 authors' registrations are now Complimentary, with a Presenter badge."]);
    expect(makePresentersNeedsAttention(outcome)).toBe(false);
    expect(describeMakePresenters({ ...NONE, made: ["1"] }, numberOf)[0]).toContain("1 author's registration is now");
  });

  it("names the authors with no registration, and says where to give one", () => {
    const outcome = { ...NONE, noRegistration: ["7", "9"] };
    expect(describeMakePresenters(outcome, numberOf)).toEqual(["No registration yet, so nothing to make Complimentary: A-7, A-9. Give one from the speaker's page."]);
    expect(makePresentersNeedsAttention(outcome)).toBe(true);
  });

  it("names the ones left as they are, one line per reason, in the bulk action's own words", () => {
    const outcome = {
      ...NONE,
      skipped: [
        { abstractId: "3", part: "paymentStatus", code: "HAS_MONEY", message: "Has a payment on it." },
        { abstractId: "4", part: "paymentStatus", code: "HAS_MONEY", message: "Has a payment on it." },
        { abstractId: "5", part: "paymentStatus", code: "SPONSOR_PAID", message: "Paid by a sponsor." },
      ],
    };
    expect(describeMakePresenters(outcome, numberOf)).toEqual([
      "Payment status left as it is: A-3, A-4. Has a payment on it.",
      "Payment status left as it is: A-5. Paid by a sponsor.",
    ]);
    expect(makePresentersNeedsAttention(outcome)).toBe(true);
  });

  it("already as asked is said and is not a problem; what was not reached is", () => {
    expect(describeMakePresenters({ ...NONE, already: ["1"] }, numberOf)).toEqual(["Already Complimentary with the badge: A-1."]);
    expect(makePresentersNeedsAttention({ ...NONE, already: ["1"] })).toBe(false);
    expect(describeMakePresenters({ ...NONE, remaining: ["8"] }, numberOf)[0]).toContain("Not reached: A-8.");
  });

  it("a long list is cut with a count, never dumped", () => {
    const many = Array.from({ length: 40 }, (_, i) => String(i));
    expect(describeMakePresenters({ ...NONE, noRegistration: many }, numberOf)[0]).toContain("and 10 more");
  });
});
