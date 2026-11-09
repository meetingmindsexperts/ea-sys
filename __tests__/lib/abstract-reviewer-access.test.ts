/**
 * Who may review an abstract: the pool and the assignment, never the role, and
 * never your own abstract (Nov 9, 2026).
 */
import { describe, it, expect } from "vitest";
import { excludeOwnAbstracts, isOnReviewerPool, isOwnAbstract } from "@/lib/abstract-reviewer-access";

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
  it("leaves out the account's and the address's abstracts", () => {
    expect(excludeOwnAbstracts({ id: "u1", email: "me@example.com" })).toEqual({
      NOT: { speaker: { OR: [{ userId: "u1" }, { email: { equals: "me@example.com", mode: "insensitive" } }] } },
    });
  });

  it("without an address, only the account", () => {
    expect(excludeOwnAbstracts({ id: "u1", email: null })).toEqual({ NOT: { speaker: { OR: [{ userId: "u1" }] } } });
  });
});
