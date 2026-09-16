/**
 * The procurement predicates fail closed and keep the three grants apart:
 * a settle grant cannot approve, a request grant cannot settle, and an
 * approver's ceiling is inclusive and in AED.
 */
import { describe, it, expect } from "vitest";
import {
  approvalCeilingAed,
  canAdminProcurement,
  canApproveProcurement,
  canAuthorBudgets,
  canDecideSuppliers,
  canRequestProcurement,
  canSettleProcurement,
  canViewProcurement,
  hasAnyProcurementGrant,
  isFinalApproverHoldingRequestGrant,
} from "@/lib/procurement-visibility";

describe("procurement visibility", () => {
  it("reads: org staff without a grant, or anyone holding a grant; nobody else", () => {
    for (const role of ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER"]) expect(canViewProcurement({ role })).toBe(true);
    for (const role of ["ONSITE", "CRM_USER", "HR_USER", "WEBINARS", "REVIEWER", "SUBMITTER", "REGISTRANT"]) {
      expect(canViewProcurement({ role })).toBe(false);
      expect(canViewProcurement({ role, procurementRequest: true })).toBe(true);
    }
    expect(canViewProcurement(null)).toBe(false);
    expect(canViewProcurement({ role: null })).toBe(false);
    expect(canViewProcurement({ role: "NEW_ROLE_NOBODY_CLASSIFIED" })).toBe(false);
  });

  it("authoring and admin stay role-based for anyone holding no custom role", () => {
    expect(canAuthorBudgets({ role: "ORGANIZER" })).toBe(true);
    // The three GRANTS still do not confer authoring: only a custom role does.
    expect(canAuthorBudgets({ role: "MEMBER", procurementRequest: true, procurementSettle: true })).toBe(false);
    expect(canAdminProcurement({ role: "ADMIN" })).toBe(true);
    expect(canAdminProcurement({ role: "ORGANIZER" })).toBe(false);
  });

  it("a custom role grants budget authoring to a MEMBER, which no role does", () => {
    // THE ASSERTION THIS FEATURE EXISTS TO CHANGE. Every project manager is a
    // MEMBER (owner, Sep 16 2026) and a MEMBER authors nothing by role, so
    // before custom roles the requirement was inexpressible.
    const pm = { role: "MEMBER", procurementPermissions: ["procurement.budgets.create"] };
    expect(canAuthorBudgets(pm)).toBe(true);
    expect(canViewProcurement(pm)).toBe(true);
    // And the other direction: the key does not leak into unrelated authority.
    expect(canApproveProcurement(pm, 1)).toBe(false);
    expect(canSettleProcurement(pm)).toBe(false);
    expect(canAdminProcurement(pm)).toBe(false);
  });

  it("each key unlocks only its own predicate, never a neighbour", () => {
    expect(canRequestProcurement({ role: "ONSITE", procurementPermissions: ["procurement.requests.create"] })).toBe(true);
    expect(canSettleProcurement({ role: "ONSITE", procurementPermissions: ["procurement.requests.create"] })).toBe(false);
    expect(canSettleProcurement({ role: "MEMBER", procurementPermissions: ["procurement.budgets.signoff"] })).toBe(true);
    expect(canDecideSuppliers({ role: "MEMBER", procurementPermissions: ["procurement.suppliers.decide"] })).toBe(true);
    expect(canDecideSuppliers({ role: "MEMBER", procurementPermissions: ["procurement.suppliers.view"] })).toBe(false);
    expect(canAdminProcurement({ role: "MEMBER", procurementPermissions: ["procurement.requests.manage"] })).toBe(true);
  });

  it("holding a permission is never authority to approve an amount (D3)", () => {
    // `approvals.decide` says WHETHER; the AED ceiling on the person says HOW
    // MUCH. A key with no ceiling approves nothing.
    const keyOnly = { role: "MEMBER", procurementPermissions: ["procurement.approvals.decide"] };
    expect(approvalCeilingAed(keyOnly)).toBeNull();
    expect(canApproveProcurement(keyOnly, 1)).toBe(false);
    const withCeiling = { ...keyOnly, procurementApproveCeilingAed: 5_000 };
    expect(canApproveProcurement(withCeiling, 5_000)).toBe(true);
    expect(canApproveProcurement(withCeiling, 5_001)).toBe(false);
  });

  it("an empty or absent permission list changes nothing at all", () => {
    // The transition contract: absent means "not resolved here", never
    // "holds nothing", so every un-taught caller behaves exactly as before.
    expect(canViewProcurement({ role: "ONSITE", procurementPermissions: [] })).toBe(false);
    expect(canViewProcurement({ role: "ONSITE" })).toBe(false);
    expect(canAuthorBudgets({ role: "ORGANIZER", procurementPermissions: [] })).toBe(true);
    expect(canAuthorBudgets({ role: "MEMBER", procurementPermissions: [] })).toBe(false);
    expect(canViewProcurement({ role: "ONSITE", procurementPermissions: ["procurement.orders.view"] })).toBe(true);
  });

  it("keeps the three grants apart", () => {
    const settle = { role: "MEMBER", procurementSettle: true };
    expect(canSettleProcurement(settle)).toBe(true);
    expect(canApproveProcurement(settle, 1)).toBe(false);
    expect(canRequestProcurement(settle)).toBe(false);
    const requester = { role: "CRM_USER", procurementRequest: true };
    expect(canRequestProcurement(requester)).toBe(true);
    expect(canSettleProcurement(requester)).toBe(false);
    expect(hasAnyProcurementGrant({ role: "MEMBER" })).toBe(false);
    expect(hasAnyProcurementGrant({ role: "MEMBER", procurementApproveCeilingAed: 0 })).toBe(false);
  });

  it("suppliers are decided by the settle holder, a super admin or the final approver, and nobody else", () => {
    expect(canDecideSuppliers({ role: "MEMBER", procurementSettle: true })).toBe(true);
    expect(canDecideSuppliers({ role: "SUPER_ADMIN" })).toBe(true);
    expect(canDecideSuppliers({ role: "ORGANIZER", procurementApproveUnlimited: true })).toBe(true);
    expect(canDecideSuppliers({ role: "ADMIN" })).toBe(false);
    expect(canDecideSuppliers({ role: "ADMIN", procurementApproveCeilingAed: 1_000_000 })).toBe(false);
    expect(canDecideSuppliers({ role: "MEMBER", procurementRequest: true })).toBe(false);
    expect(canDecideSuppliers(null)).toBe(false);
  });

  it("approval authority is an inclusive AED ceiling; unlimited outranks it; zero is none", () => {
    const lina = { role: "ADMIN", procurementApproveCeilingAed: 1_000_000 };
    expect(approvalCeilingAed(lina)).toBe(1_000_000);
    expect(canApproveProcurement(lina, 1_000_000)).toBe(true);
    expect(canApproveProcurement(lina, 1_000_000.01)).toBe(false);
    const medhat = { role: "SUPER_ADMIN", procurementApproveUnlimited: true, procurementApproveCeilingAed: 5 };
    expect(approvalCeilingAed(medhat)).toBe(Number.POSITIVE_INFINITY);
    expect(canApproveProcurement(medhat, 9_999_999_999)).toBe(true);
    expect(approvalCeilingAed({ role: "ADMIN", procurementApproveCeilingAed: 0 })).toBeNull();
    expect(canApproveProcurement({ role: "SUPER_ADMIN" }, 1)).toBe(false);
    expect(canApproveProcurement(lina, Number.NaN)).toBe(false);
    expect(canApproveProcurement(lina, -1)).toBe(false);
  });

  it("names the one grant combination spec §8.8 forbids", () => {
    expect(isFinalApproverHoldingRequestGrant({ role: "SUPER_ADMIN", procurementApproveUnlimited: true, procurementRequest: true })).toBe(true);
    expect(isFinalApproverHoldingRequestGrant({ role: "SUPER_ADMIN", procurementApproveUnlimited: true })).toBe(false);
    expect(isFinalApproverHoldingRequestGrant({ role: "ADMIN", procurementApproveCeilingAed: 100, procurementRequest: true })).toBe(false);
  });
});
