/**
 * `procurementGrantsFromRow` is the ONE mapper both decision-time reads call
 * (approvals-service and commitment-service), so flattening the nested
 * custom-role rows there is what makes the `permissionSets` select they carry
 * actually decide something.
 *
 * The bug this pins was real for one commit: the select was added at both call
 * sites and the rows were then thrown away. That shape is the worst available —
 * it looks wired, costs a join, and grants nothing.
 */
import { describe, it, expect } from "vitest";
import { procurementGrantsFromRow, canAuthorBudgets } from "@/lib/procurement-visibility";

const held = (...keys: string[]) => ({
  permissionSets: [{ permissionSet: { permissions: keys.map((permission) => ({ permission })) } }],
});

describe("procurementGrantsFromRow: custom-role permissions", () => {
  it("flattens the nested rows into keys the predicates can read", () => {
    const g = procurementGrantsFromRow({ ...held("procurement.budgets.create"), role: "MEMBER" } as never);
    expect(g.procurementPermissions).toEqual(["procurement.budgets.create"]);
    // The end-to-end point: a MEMBER row now authors.
    expect(canAuthorBudgets({ role: "MEMBER", ...g })).toBe(true);
  });

  it("unions across several roles and deduplicates", () => {
    const g = procurementGrantsFromRow({
      permissionSets: [
        { permissionSet: { permissions: [{ permission: "procurement.budgets.view" }, { permission: "procurement.orders.view" }] } },
        { permissionSet: { permissions: [{ permission: "procurement.budgets.view" }, { permission: "procurement.requests.create" }] } },
      ],
    } as never);
    expect(new Set(g.procurementPermissions)).toEqual(
      new Set(["procurement.budgets.view", "procurement.orders.view", "procurement.requests.create"]),
    );
    expect(g.procurementPermissions).toHaveLength(3);
  });

  it("an unselected relation is UNDEFINED, not empty: absent means 'not resolved here'", () => {
    // The transition contract. Empty would read as "holds nothing" and could
    // later be mistaken for a decision; undefined says the caller never asked.
    const g = procurementGrantsFromRow({ procurementRequest: true });
    expect(g.procurementPermissions).toBeUndefined();
    // And the legacy arm still decides for that caller, unchanged.
    expect(canAuthorBudgets({ role: "ORGANIZER", ...g })).toBe(true);
    expect(canAuthorBudgets({ role: "MEMBER", ...g })).toBe(false);
  });

  it("a person holding roles with no ticks resolves to an empty set, not undefined", () => {
    const g = procurementGrantsFromRow({ permissionSets: [{ permissionSet: { permissions: [] } }] } as never);
    expect(g.procurementPermissions).toEqual([]);
  });

  it("still maps the four legacy grants, Decimal ceiling included", () => {
    const g = procurementGrantsFromRow({
      procurementRequest: true,
      procurementApproveCeilingAed: { toString: () => "5000.00" },
      procurementSettle: false,
      ...held("procurement.requests.create"),
    } as never);
    expect(g.procurementRequest).toBe(true);
    expect(g.procurementApproveCeilingAed).toBe(5000);
    expect(g.procurementPermissions).toEqual(["procurement.requests.create"]);
  });
});
