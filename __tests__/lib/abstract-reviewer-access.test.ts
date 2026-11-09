/**
 * Who may review an abstract: the pool and the assignment, never the role, and
 * never your own abstract (Nov 9, 2026).
 */
import { describe, it, expect } from "vitest";
import { becomesSubmitterToAuthor, excludeOwnAbstracts, isOnReviewerPool, isOwnAbstract, mustConfirmEmailToReview } from "@/lib/abstract-reviewer-access";
import { computeWeightedOverallScore } from "@/lib/abstract-score";

describe("isOnReviewerPool", () => {
  it("reads the event's list and fails closed on anything else", () => {
    expect(isOnReviewerPool({ reviewerUserIds: ["u1"] }, "u1")).toBe(true);
    expect(isOnReviewerPool({ reviewerUserIds: ["u2"] }, "u1")).toBe(false);
    expect(isOnReviewerPool({ reviewerUserIds: "u1" }, "u1")).toBe(false);
    expect(isOnReviewerPool({}, "u1")).toBe(false);
    expect(isOnReviewerPool(null, "u1")).toBe(false);
  });
});

describe("isOwnAbstract", () => {
  const me = { id: "u1", email: "Me@Example.com" };

  it("matches the linked account", () => {
    expect(isOwnAbstract({ userId: "u1", email: "other@example.com" }, me)).toBe(true);
  });

  it("matches an unlinked speaker row by address, whatever the case", () => {
    expect(isOwnAbstract({ userId: null, email: " me@example.com " }, me)).toBe(true);
  });

  it("is not someone else's, and a missing address never matches a missing address", () => {
    expect(isOwnAbstract({ userId: "u2", email: "other@example.com" }, me)).toBe(false);
    expect(isOwnAbstract({ userId: "u2", email: null }, { id: "u1", email: null })).toBe(false);
    expect(isOwnAbstract(null, me)).toBe(false);
  });
});

describe("excludeOwnAbstracts", () => {
  // A NOT around the OR is NULL for a speaker with no linked account, and hid
  // those abstracts from everyone (review of c0cc0928). Checked on a real
  // database when written; this pins the shape that made it safe.
  it("keeps a speaker with no linked account, and leaves out the account's and the address's", () => {
    expect(excludeOwnAbstracts({ id: "u1", email: "me@example.com" })).toEqual({
      speaker: {
        AND: [
          { OR: [{ userId: null }, { userId: { not: "u1" } }] },
          { NOT: { email: { equals: "me@example.com", mode: "insensitive" } } },
        ],
      },
    });
  });

  it("without an address, only the account", () => {
    expect(excludeOwnAbstracts({ id: "u1", email: null })).toEqual({
      speaker: { AND: [{ OR: [{ userId: null }, { userId: { not: "u1" } }] }] },
    });
  });
});

describe("mustConfirmEmailToReview", () => {
  it.each(["REVIEWER", "SUBMITTER", "REGISTRANT"])("asks a %s until the address is proven", (role) => {
    expect(mustConfirmEmailToReview({ role, emailConfirmedAt: null })).toBe(true);
    expect(mustConfirmEmailToReview({ role, emailConfirmedAt: new Date() })).toBe(false);
  });
  it("does not ask staff, and fails closed on a missing account", () => {
    expect(mustConfirmEmailToReview({ role: "ORGANIZER", emailConfirmedAt: null })).toBe(false);
    expect(mustConfirmEmailToReview(null)).toBe(true);
  });
});

describe("computeWeightedOverallScore", () => {
  it("divides by the weights present", () => {
    expect(computeWeightedOverallScore([{ score: 8, weight: 60 }, { score: 0, weight: 40 }])).toBe(48);
    expect(computeWeightedOverallScore([{ score: 10, weight: 10 }, { score: 10, weight: 10 }])).toBe(100);
    expect(computeWeightedOverallScore([{ score: 10, weight: 50 }, { score: 0, weight: 50 }, { score: 0, weight: 50 }])).toBe(33);
    expect(computeWeightedOverallScore([])).toBeNull();
  });
});

describe("becomesSubmitterToAuthor", () => {
  it.each(["REGISTRANT", "REVIEWER"])("%s does", (role) => expect(becomesSubmitterToAuthor(role)).toBe(true));
  it.each(["SUBMITTER", "ADMIN", "ORGANIZER", "MEMBER", null, undefined])("%s does not", (role) => expect(becomesSubmitterToAuthor(role)).toBe(false));
});
