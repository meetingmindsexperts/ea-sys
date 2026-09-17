/**
 * `hasProcurementAccess`: does this person have procurement access by ANY
 * route, a legacy grant or a custom role tagged on them?
 *
 * Its own file because the predicate had no test home: nothing under __tests__
 * referenced the grants dialog before. Deliberately NOT folded into
 * permission-separation.test.ts, which tests a different rule set.
 */
import { describe, it, expect } from "vitest";
import { hasAnyGrant, hasProcurementAccess } from "@/components/settings/procurement-grants-dialog";

const person = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  firstName: "A",
  lastName: "B",
  email: "a@b.test",
  ...over,
});

describe("hasProcurementAccess", () => {
  it("is false for somebody with neither a grant nor a role", () => {
    expect(hasProcurementAccess(person())).toBe(false);
  });
  it("is true on a legacy grant alone", () => {
    expect(hasProcurementAccess(person({ procurementSettle: true }))).toBe(true);
    expect(hasProcurementAccess(person({ procurementApproveCeilingAed: 5000 }))).toBe(true);
  });
  it("is true on a ROLE alone, which is the gap this closes", () => {
    // Before this, somebody holding PO Author showed a grey Wallet on
    // Settings -> Team, indistinguishable from no procurement access at all,
    // because the predicate read only the four legacy columns.
    expect(hasProcurementAccess(person({ permissionSetCount: 1 }))).toBe(true);
  });
  it("treats a count of 0 and an absent count alike", () => {
    expect(hasProcurementAccess(person({ permissionSetCount: 0 }))).toBe(false);
    expect(hasProcurementAccess(person())).toBe(false);
  });
  it("leaves hasAnyGrant meaning GRANTS only", () => {
    // Left narrow on purpose: other callers rely on that question, and widening
    // it in place would change their answer silently.
    expect(hasAnyGrant(person({ permissionSetCount: 3 }))).toBe(false);
    expect(hasAnyGrant(person({ procurementRequest: true }))).toBe(true);
  });
});
