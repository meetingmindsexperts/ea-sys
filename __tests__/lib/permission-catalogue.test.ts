/**
 * The permission catalogue is kept honest by this file.
 *
 * Two failures are silent without it, and both look like access:
 *   * a KEY with no descriptor renders as a blank checkbox in the role editor,
 *     so an administrator ticks something with no label;
 *   * a DESCRIPTOR with no key is a checkbox that grants nothing, which reads
 *     as permission and is not.
 *
 * The starter-role assertions exist for a different reason: the two separation
 * rules (docs/PROCUREMENT_ROLES_PLAN.md §4) are enforced on the UNION at
 * assignment time, but a SEEDED role that breaks one of them would be refused
 * the moment anybody tried to use it, which is a bug nobody meets until the
 * first assignment on a new organisation.
 */
import { describe, it, expect } from "vitest";
import {
  PERMISSION_KEYS,
  PERMISSION_CATALOGUE,
  PERMISSION_GROUPS,
  STARTER_ROLES,
  isPermissionKey,
} from "@/lib/permissions/catalogue";

describe("permission catalogue", () => {
  it("describes every key exactly once", () => {
    const described = PERMISSION_CATALOGUE.map((p) => p.key);
    expect([...described].sort()).toEqual([...PERMISSION_KEYS].sort());
    expect(new Set(described).size).toBe(described.length);
  });

  it("puts every descriptor in a declared group", () => {
    for (const d of PERMISSION_CATALOGUE) {
      expect(PERMISSION_GROUPS).toContain(d.group);
    }
  });

  it("gives every permission a label and a sentence a non-developer can read", () => {
    for (const d of PERMISSION_CATALOGUE) {
      expect(d.label.trim().length).toBeGreaterThan(0);
      expect(d.description.trim().length).toBeGreaterThan(10);
      // The label is what an administrator ticks; a key leaking into it means
      // somebody pasted the identifier instead of writing the words.
      expect(d.label).not.toContain("procurement.");
    }
  });

  it("namespaces every key, so a second module cannot collide (D5)", () => {
    for (const key of PERMISSION_KEYS) {
      expect(key.startsWith("procurement.")).toBe(true);
    }
  });

  it("recognises only real keys, and fails closed on anything else", () => {
    expect(isPermissionKey("procurement.budgets.create")).toBe(true);
    expect(isPermissionKey("procurement.budgets.reopen")).toBe(false); // D15: folded into edit
    expect(isPermissionKey("procurement.budgets.delete")).toBe(false);
    expect(isPermissionKey("")).toBe(false);
    expect(isPermissionKey("budgets.create")).toBe(false);
  });
});

describe("starter roles (D11, narrowed by D14)", () => {
  it("seeds exactly the four the owner chose", () => {
    expect(STARTER_ROLES.map((r) => r.name)).toEqual([
      "PO Author",
      "PO Approver",
      "Requester",
      "Finance Settle",
    ]);
  });

  it("only grants permissions this build enforces", () => {
    for (const role of STARTER_ROLES) {
      expect(role.permissions.length).toBeGreaterThan(0);
      for (const key of role.permissions) {
        expect(isPermissionKey(key)).toBe(true);
      }
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
    }
  });

  it("never seeds an approver who can also raise a request (§4 rule 1)", () => {
    for (const role of STARTER_ROLES) {
      const decides = role.permissions.includes("procurement.approvals.decide");
      const raises = role.permissions.includes("procurement.requests.create");
      expect(decides && raises).toBe(false);
    }
  });

  it("never seeds a settle holder who can also decide (§4 rule 2)", () => {
    for (const role of STARTER_ROLES) {
      const settles = role.permissions.includes("procurement.budgets.signoff");
      const decides = role.permissions.includes("procurement.approvals.decide");
      expect(settles && decides).toBe(false);
    }
  });

  it("makes PO Author the project-manager role: it authors budgets AND buys (D14)", () => {
    const poAuthor = STARTER_ROLES.find((r) => r.name === "PO Author");
    expect(poAuthor).toBeDefined();
    // The gap in docs/PROCUREMENT_ROLES_PLAN.md §0: a MEMBER authors nothing by
    // role, and every project manager is a MEMBER.
    expect(poAuthor!.permissions).toContain("procurement.budgets.create");
    expect(poAuthor!.permissions).toContain("procurement.budgets.edit");
    expect(poAuthor!.permissions).toContain("procurement.requests.create");
  });

  it("keeps Requester off the Budgets screen (D7)", () => {
    const requester = STARTER_ROLES.find((r) => r.name === "Requester");
    expect(requester).toBeDefined();
    // Richard's rule: raises requests, sees the line he is spending against,
    // does not get the Budgets list.
    expect(requester!.permissions).not.toContain("procurement.budgets.view");
    expect(requester!.permissions).toContain("procurement.requests.create");
  });
});
