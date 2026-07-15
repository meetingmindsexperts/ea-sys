/**
 * The CRM_USER role — a CRM-confined team role.
 *
 * This is the RBAC contract: CRM_USER works the CRM fully (owns deals, sees deal
 * money) but is walled off from everything outside it (events, non-CRM writes,
 * event finance). These tests pin every boundary so a future edit to one role set
 * can't silently widen or break it.
 */
import { describe, it, expect } from "vitest";
import { canViewCrm, canOwnDeals, canViewDealValues } from "@/crm/lib/crm-roles";
import { canViewContacts } from "@/lib/contact-visibility";
import { canViewFinance } from "@/lib/finance-visibility";
import { isTeamRole, denyReviewer, TEAM_ROLES } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";

describe("CRM_USER can fully work the CRM", () => {
  it("reads the CRM, owns deals, and sees deal values", () => {
    expect(canViewCrm("CRM_USER")).toBe(true);
    expect(canOwnDeals("CRM_USER")).toBe(true);
    expect(canViewDealValues("CRM_USER")).toBe(true);
  });

  it("can search the event contact store (to link a rep — owner decision)", () => {
    expect(canViewContacts("CRM_USER")).toBe(true);
  });

  it("is an org-bound team role", () => {
    expect(isTeamRole("CRM_USER")).toBe(true);
    expect(TEAM_ROLES).toContain("CRM_USER");
  });
});

describe("CRM_USER is walled off from everything outside the CRM", () => {
  it("does NOT see event finances (not in FINANCE_ROLES)", () => {
    // The one subtle line: CRM_USER sees CRM DEAL money (canViewDealValues) but
    // NOT event invoices/registration payments (canViewFinance). Different money.
    expect(canViewFinance("CRM_USER")).toBe(false);
  });

  it("is blocked from non-CRM writes by denyReviewer", () => {
    // /api/crm/* uses its own requireCrmWrite; denyReviewer guards the REST of the
    // app, and must block CRM_USER there.
    const denied = denyReviewer({ user: { role: "CRM_USER" } } as never);
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
  });

  it("sees ZERO events via buildEventAccessWhere (uses events-lite for names)", () => {
    const where = buildEventAccessWhere({ id: "u-1", role: "CRM_USER", organizationId: "org-1" });
    // An impossible predicate — matches nothing, so an event route returns empty/404.
    expect(where).toEqual({ id: { in: [] } });
  });
});

describe("CRM_USER vs MEMBER — the meaningful difference", () => {
  it("both read the board, but only CRM_USER can write and see money", () => {
    expect(canViewCrm("MEMBER")).toBe(true);
    expect(canViewCrm("CRM_USER")).toBe(true);

    expect(canOwnDeals("MEMBER")).toBe(false); // read-only
    expect(canOwnDeals("CRM_USER")).toBe(true); // works the pipeline

    expect(canViewDealValues("MEMBER")).toBe(false); // money hidden
    expect(canViewDealValues("CRM_USER")).toBe(true); // sales sees money
  });
});
