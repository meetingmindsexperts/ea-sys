/**
 * The two rules that must survive combining roles (plan §4).
 *
 * These are the whole reason a role is not just a bag of ticks: two roles that
 * are each defensible combine into one person who approves their own purchase.
 * The rules are checked at three doors (assigning roles, editing a role people
 * hold, changing someone's AED authority), so the pure function they share is
 * where the behaviour is pinned.
 */
import { describe, it, expect } from "vitest";
import { separationConflicts, unionPermissions } from "@/lib/permissions/separation";
import { STARTER_ROLES } from "@/lib/permissions/catalogue";

const REQUEST = "procurement.requests.create";
const DECIDE = "procurement.approvals.decide";
const SIGNOFF = "procurement.budgets.signoff";

describe("separationConflicts", () => {
  it("passes a role on its own that holds neither pair", () => {
    expect(separationConflicts({ permissions: [REQUEST, "procurement.orders.receive"] })).toEqual([]);
  });

  it("refuses the final approver who can also raise requests", () => {
    const conflicts = separationConflicts({ permissions: [REQUEST], approvalUnlimited: true });
    expect(conflicts.map((c) => c.code)).toEqual(["FINAL_APPROVER_CANNOT_REQUEST"]);
  });

  it("allows a BANDED approver to raise requests: only the final tier is barred", () => {
    // A ceiling holder has somebody above them, so their own request still
    // reaches a different person. Refusing here would make a working setup
    // unexpressible.
    expect(separationConflicts({ permissions: [REQUEST, DECIDE], approvalUnlimited: false })).toEqual([]);
  });

  it("refuses sign-off held together with approving", () => {
    const conflicts = separationConflicts({ permissions: [SIGNOFF, DECIDE] });
    expect(conflicts.map((c) => c.code)).toEqual(["SETTLE_CANNOT_DECIDE"]);
  });

  it("reads the LEGACY columns too, so an old switch plus a new role is caught", () => {
    // Muthu on production holds the settle column and no role. Giving him a
    // role that approves has to be refused exactly as if he held both keys.
    const conflicts = separationConflicts({ permissions: [DECIDE], legacySettle: true });
    expect(conflicts.map((c) => c.code)).toEqual(["SETTLE_CANNOT_DECIDE"]);
  });

  it("catches the legacy request column against a new unlimited authority", () => {
    const conflicts = separationConflicts({ permissions: [], approvalUnlimited: true, legacyRequest: true });
    expect(conflicts.map((c) => c.code)).toEqual(["FINAL_APPROVER_CANNOT_REQUEST"]);
  });

  it("reports BOTH rules at once rather than only the first", () => {
    const conflicts = separationConflicts({ permissions: [REQUEST, DECIDE, SIGNOFF], approvalUnlimited: true });
    expect(conflicts.map((c) => c.code).sort()).toEqual(["FINAL_APPROVER_CANNOT_REQUEST", "SETTLE_CANNOT_DECIDE"]);
  });

  it("says nothing about an unknown AED authority, which is how a ROLE is judged", () => {
    // The role editor knows the ticks but not who will hold them, so rule 1
    // cannot fire there; only rule 2 is decidable on a role alone.
    expect(separationConflicts({ permissions: [REQUEST] })).toEqual([]);
  });
});

describe("the seeded roles obey their own rules", () => {
  it("no starter role conflicts with itself", () => {
    for (const role of STARTER_ROLES) {
      expect({ role: role.name, conflicts: separationConflicts({ permissions: role.permissions }) }).toEqual({
        role: role.name,
        conflicts: [],
      });
    }
  });

  it("PO Approver and Finance Settle cannot be held by one person", () => {
    // The pair the separation exists for: one decides, the other signs off.
    const approver = STARTER_ROLES.find((r) => r.name === "PO Approver")!;
    const settle = STARTER_ROLES.find((r) => r.name === "Finance Settle")!;
    const conflicts = separationConflicts({ permissions: [...approver.permissions, ...settle.permissions] });
    expect(conflicts.map((c) => c.code)).toEqual(["SETTLE_CANNOT_DECIDE"]);
  });

  it("PO Author cannot be held by the final approver", () => {
    const author = STARTER_ROLES.find((r) => r.name === "PO Author")!;
    const conflicts = separationConflicts({ permissions: author.permissions, approvalUnlimited: true });
    expect(conflicts.map((c) => c.code)).toEqual(["FINAL_APPROVER_CANNOT_REQUEST"]);
  });
});

describe("unionPermissions", () => {
  it("deduplicates across roles", () => {
    const keys = unionPermissions([
      { permissions: [{ permission: "a" }, { permission: "b" }] },
      { permissions: [{ permission: "b" }, { permission: "c" }] },
    ]);
    expect(new Set(keys)).toEqual(new Set(["a", "b", "c"]));
    expect(keys.length).toBe(3);
  });

  it("is empty for no roles, which is what holding none means", () => {
    expect(unionPermissions([])).toEqual([]);
  });
});
