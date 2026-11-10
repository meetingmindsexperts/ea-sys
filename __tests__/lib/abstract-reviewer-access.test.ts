/**
 * Who may review an abstract: the assignment, never the role, never the pool
 * alone (Nov 10, 2026), and never your own abstract (Nov 9, 2026).
 */
import { describe, it, expect } from "vitest";
import { assignedToReviewWhere, becomesSubmitterToAuthor, excludeOwnAbstracts, isOnReviewerPool, isOwnAbstract, linkedRoleAbstractFilter, mustConfirmEmailToReview, reviewerAccountIsSetUp } from "@/lib/abstract-reviewer-access";
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
  it.each(["SUBMITTER", "REGISTRANT"])("asks a %s until the address is proven", (role) => {
    expect(mustConfirmEmailToReview({ role, emailConfirmedAt: null })).toBe(true);
    expect(mustConfirmEmailToReview({ role, emailConfirmedAt: new Date() })).toBe(false);
  });

  it("a session the confirmation revoked does not inherit it", () => {
    const account = { role: "SUBMITTER", emailConfirmedAt: new Date(), tokenVersion: 3 };
    expect(mustConfirmEmailToReview(account, 2)).toBe(true);
    expect(mustConfirmEmailToReview(account, 3)).toBe(false);
    expect(mustConfirmEmailToReview({ role: "SUBMITTER", emailConfirmedAt: new Date(), tokenVersion: null }, 0)).toBe(false);
  });

  it("does not ask a REVIEWER or staff, and fails closed on a missing account", () => {
    expect(mustConfirmEmailToReview({ role: "REVIEWER", emailConfirmedAt: null })).toBe(false);
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

describe("linkedRoleAbstractFilter", () => {
  it("a REVIEWER lists the abstracts assigned to them, whatever pool they sit on", () => {
    expect(linkedRoleAbstractFilter({ id: "u1", role: "REVIEWER" })).toEqual(assignedToReviewWhere("u1"));
    expect(assignedToReviewWhere("u1")).toEqual({ reviewers: { some: { userId: "u1" } } });
  });

  it("a SUBMITTER lists their own; staff get nothing added (their permissions scope them)", () => {
    expect(linkedRoleAbstractFilter({ id: "u1", role: "SUBMITTER" })).toEqual({ speaker: { userId: "u1" } });
    expect(linkedRoleAbstractFilter({ id: "u1", role: "ORGANIZER" })).toEqual({});
  });

  it("a REGISTRANT reaches nothing: fails closed if a route ever lets one in", () => {
    expect(linkedRoleAbstractFilter({ id: "u1", role: "REGISTRANT" })).toEqual({ id: { in: [] } });
  });
});

describe("reviewerAccountIsSetUp: who needs the setup invitation", () => {
  it("an invited reviewer account is waiting until the invitation is accepted", () => {
    expect(reviewerAccountIsSetUp({ role: "REVIEWER", emailVerified: null })).toBe(false);
    expect(reviewerAccountIsSetUp({ role: "REVIEWER", emailVerified: new Date() })).toBe(true);
  });

  it("a registrant or submitter made their own account, with a password: never the setup link, which would replace it", () => {
    // A registrant usually has no emailVerified at all (owner, Nov 10, 2026).
    expect(reviewerAccountIsSetUp({ role: "REGISTRANT", emailVerified: null })).toBe(true);
    expect(reviewerAccountIsSetUp({ role: "SUBMITTER", emailVerified: null })).toBe(true);
  });

  it("a staff account on a pool is never mailed a reviewer link, pending or not (review of 94a2aee5)", () => {
    // Added from its speaker record, or promoted after being added: the link
    // would replace its staff invitation and activate the account.
    for (const role of ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER", "ONSITE", "CRM_USER", "HR_USER", "BASE"]) {
      expect(reviewerAccountIsSetUp({ role, emailVerified: null }), role).toBe(true);
    }
  });

  it("no account, or one whose role is unknown, is not treated as able to sign in", () => {
    expect(reviewerAccountIsSetUp(null)).toBe(false);
    expect(reviewerAccountIsSetUp({ emailVerified: null })).toBe(false);
  });
});
