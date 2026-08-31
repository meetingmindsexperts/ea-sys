import { describe, it, expect, afterEach } from "vitest";
import { canViewHr, canWriteHr, denyNonHr } from "@/hr/lib/hr-roles";
import { buildEventAccessWhere } from "@/lib/event-access";
import { denyReviewer, ASSIGNABLE_USER_ROLES } from "@/lib/auth-guards";
import { TEAM_ROLES, isTeamRole } from "@/lib/team-roles";

const ORIGINAL = process.env.HR_MODULE_ENABLED;
function withHr(enabled: boolean) {
  if (enabled) process.env.HR_MODULE_ENABLED = "true";
  else delete process.env.HR_MODULE_ENABLED;
}
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.HR_MODULE_ENABLED;
  else process.env.HR_MODULE_ENABLED = ORIGINAL;
});

const EVERY_ROLE = [
  "SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER", "REVIEWER", "SUBMITTER",
  "REGISTRANT", "CRM_USER", "ONSITE", "WEBINARS", "HR_USER",
] as const;

describe("who may reach the HR module", () => {
  /**
   * ADMIN used to be enough on its own. It is not (owner, Aug 31 2026): there
   * are three admins and only two of them belong in HR, so the grant became an
   * explicit per-person flag rather than a side effect of a role that exists to
   * run the events business.
   */
  it("admits, on role alone, exactly SUPER_ADMIN and HR_USER", () => {
    const allowed = EVERY_ROLE.filter((role) => canViewHr({ role }));
    expect([...allowed].sort()).toEqual(["HR_USER", "SUPER_ADMIN"]);
  });

  it("no longer lets ADMIN in without an explicit grant", () => {
    expect(canViewHr({ role: "ADMIN" })).toBe(false);
    expect(canWriteHr({ role: "ADMIN" })).toBe(false);
    expect(canViewHr({ role: "ADMIN", hrAccess: true })).toBe(true);
    expect(canWriteHr({ role: "ADMIN", hrAccess: true })).toBe(true);
  });

  /** The two role-based grants stand without a flag: SUPER_ADMIN could set its
   *  own anyway, and a HR_USER without HR access could reach nothing at all. */
  it("does not require the flag from the roles that carry access themselves", () => {
    expect(canViewHr({ role: "SUPER_ADMIN" })).toBe(true);
    expect(canViewHr({ role: "HR_USER" })).toBe(true);
    expect(canViewHr({ role: "SUPER_ADMIN", hrAccess: false })).toBe(true);
    expect(canViewHr({ role: "HR_USER", hrAccess: false })).toBe(true);
  });

  /**
   * THE ONE THAT MATTERS MOST. An API key is admin-equivalent everywhere else,
   * and the flag must not become a second way in for one: a key has no user
   * row, so an `hrAccess: true` arriving alongside a null role is either a bug
   * or a forgery. Refuse on the role, before the flag is ever consulted.
   */
  it("refuses a null role even when a grant is claimed alongside it", () => {
    expect(canViewHr({ role: null, hrAccess: true })).toBe(false);
    expect(canViewHr({ role: undefined, hrAccess: true })).toBe(false);
    expect(canWriteHr({ role: null, hrAccess: true })).toBe(false);
  });

  /** An absent flag is a refusal, so a caller that forgot to select the column
   *  fails closed rather than granting on undefined. */
  it("treats a missing flag as no grant", () => {
    expect(canViewHr({ role: "ADMIN", hrAccess: undefined })).toBe(false);
    expect(canViewHr({ role: "ADMIN", hrAccess: null })).toBe(false);
  });

  /**
   * An ORGANIZER runs events and has no business reading a colleague's sick
   * leave. This is the reason the module got its own predicate rather than
   * reusing `denyReviewer`, which lets ORGANIZER through.
   */
  it("refuses ORGANIZER, which every write guard in the app permits", () => {
    expect(canViewHr({ role: "ORGANIZER" })).toBe(false);
    expect(canWriteHr({ role: "ORGANIZER" })).toBe(false);
  });

  /** The grant is per person, not per role, so it works on any team role a
   *  super admin deliberately ticks. The route restricts WHO may tick it. */
  it("honours an explicit grant on a role that has none by default", () => {
    expect(canViewHr({ role: "ORGANIZER", hrAccess: true })).toBe(true);
    expect(canViewHr({ role: "MEMBER", hrAccess: true })).toBe(true);
  });

  /**
   * API keys are admin-equivalent everywhere else in this codebase
   * (`getOrgContext` returns role: null and the MCP surface trusts it). That
   * equivalence stops here: a key is not a person, and HR data is about people.
   */
  it("fails closed on an API key, an unknown role and no user", () => {
    expect(canViewHr({ role: null })).toBe(false);
    expect(canViewHr({ role: "SOMETHING_NEW" })).toBe(false);
    expect(canViewHr(null)).toBe(false);
    expect(canViewHr(undefined)).toBe(false);
  });
});

describe("denyNonHr", () => {
  it("404s for everyone when the module is switched off, non-HR roles included", async () => {
    withHr(false);
    // ORGANIZER and REGISTRANT are the point: the flag check must come BEFORE
    // the role check, or a switched-off module answers 403 to an outsider and
    // thereby announces that it exists (review M14).
    for (const role of ["SUPER_ADMIN", "ADMIN", "HR_USER", "ORGANIZER", "REGISTRANT"]) {
      const res = denyNonHr({ user: { id: "u1", role } }, { route: "hr:test" });
      expect(res?.status).toBe(404);
    }
  });

  /**
   * 404 rather than 403 when the module is off: a module that is not available
   * on this deployment should not announce that it exists. Once we have admitted
   * it exists, an unauthorised caller gets the honest 403.
   */
  it("distinguishes 'not here' from 'not yours'", () => {
    withHr(true);
    expect(denyNonHr({ user: { id: "u1", role: "ORGANIZER" } }, { route: "hr:test" })?.status).toBe(403);
    expect(denyNonHr({ user: { id: "u1", role: "HR_USER" } }, { route: "hr:test" })).toBeNull();
  });

  it("refuses an unauthenticated caller", () => {
    withHr(true);
    expect(denyNonHr(null, { route: "hr:test" })?.status).toBe(403);
  });
});

describe("HR_USER is confined everywhere else", () => {
  /**
   * THE HIGHEST-CONSEQUENCE LINE IN THE RBAC SURFACE.
   *
   * `RESTRICTED_WRITE_ROLES` is the only DENY-list among the role predicates;
   * every other one is an allow-list that excludes a new role for free. A role
   * absent from this list can write to every non-HR route in the application,
   * and nothing else fails loudly if you forget it.
   */
  it("is blocked from every non-HR write", () => {
    const denied = denyReviewer({ user: { id: "u1", role: "HR_USER" } }, { route: "hr:rbac-test" });
    expect(denied?.status).toBe(403);
  });

  /** Same impossible predicate as CRM_USER: an event route returns nothing. */
  it("resolves to zero events", () => {
    expect(buildEventAccessWhere({ id: "u1", role: "HR_USER", organizationId: "org1" })).toEqual({
      id: { in: [] },
    });
  });

  it("is an org team role, so it is invited from Settings like the others", () => {
    expect(isTeamRole("HR_USER")).toBe(true);
    expect(TEAM_ROLES).toContain("HR_USER");
    expect(ASSIGNABLE_USER_ROLES).toContain("HR_USER");
  });
});
