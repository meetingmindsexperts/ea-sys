/**
 * `denyReviewer`'s role list was inverted from a deny-list
 * (`RESTRICTED_WRITE_ROLES`) to an allow-list (`WRITE_ROLES`) on Sep 16, 2026 —
 * Phase 0 step 1 of docs/CUSTOM_ROLES_PLAN.md, gap G1.
 *
 * The inversion is only safe if it is behaviour-identical for every role that
 * exists today, so this pins the whole matrix rather than a sample. The
 * expectation table is hand-written on purpose: it is the statement of intent
 * that the implementation is checked against, so deriving it from `WRITE_ROLES`
 * would make the test pass by construction and prove nothing.
 *
 * The role list itself is read from the Prisma enum, so adding a role to the
 * schema fails this suite with "missing from the expectation table" instead of
 * silently inheriting whichever answer the list happens to give it. That is the
 * failure G1 existed to produce, moved from production to CI.
 */
import { describe, it, expect } from "vitest";
import { UserRole } from "@prisma/client";

import { denyReviewer, REGISTRATION_DESK_ALLOW, WEBINAR_STAFF_ALLOW, WRITE_ROLES } from "@/lib/auth-guards";

/** What each role's general write access was BEFORE the inversion, and must stay. */
const MAY_WRITE_BY_DEFAULT: Record<UserRole, boolean> = {
  SUPER_ADMIN: true,
  ADMIN: true,
  ORGANIZER: true,
  MEMBER: false,
  REVIEWER: false,
  SUBMITTER: false,
  REGISTRANT: false,
  CRM_USER: false,
  ONSITE: false,
  WEBINARS: false,
  HR_USER: false,
};

const ALL_ROLES = Object.values(UserRole);

describe("write allow-list: every role keeps the answer it had as a deny-list", () => {
  it("covers every role in the Prisma enum", () => {
    for (const role of ALL_ROLES) {
      expect(
        Object.prototype.hasOwnProperty.call(MAY_WRITE_BY_DEFAULT, role),
        `${role} is missing from the expectation table — decide whether it writes by default`,
      ).toBe(true);
    }
    expect(Object.keys(MAY_WRITE_BY_DEFAULT).sort()).toEqual([...ALL_ROLES].sort());
  });

  it.each(ALL_ROLES)("%s gets its recorded answer with no allow-list", (role) => {
    const denied = denyReviewer({ user: { role } }, { route: "parity" });
    expect(denied === null).toBe(MAY_WRITE_BY_DEFAULT[role]);
  });

  it("the allow-list is exactly the roles that write by default", () => {
    const expected = ALL_ROLES.filter((r) => MAY_WRITE_BY_DEFAULT[r]).sort();
    expect([...WRITE_ROLES].sort()).toEqual(expected);
  });
});

describe("opt-ins still admit exactly the roles they name", () => {
  it.each(ALL_ROLES)("%s under REGISTRATION_DESK_ALLOW", (role) => {
    const denied = denyReviewer({ user: { role } }, { allow: REGISTRATION_DESK_ALLOW, route: "desk" });
    const shouldPass =
      MAY_WRITE_BY_DEFAULT[role] || (REGISTRATION_DESK_ALLOW as readonly string[]).includes(role);
    expect(denied === null).toBe(shouldPass);
  });

  it.each(ALL_ROLES)("%s under WEBINAR_STAFF_ALLOW", (role) => {
    const denied = denyReviewer({ user: { role } }, { allow: WEBINAR_STAFF_ALLOW, route: "webinar" });
    const shouldPass =
      MAY_WRITE_BY_DEFAULT[role] || (WEBINAR_STAFF_ALLOW as readonly string[]).includes(role);
    expect(denied === null).toBe(shouldPass);
  });

  it("an allow-list never widens a role it does not name", () => {
    // The desk allow admits ONSITE; it must not carry REVIEWER along with it.
    expect(denyReviewer({ user: { role: "REVIEWER" } }, { allow: REGISTRATION_DESK_ALLOW, route: "desk" })).not.toBeNull();
    expect(denyReviewer({ user: { role: "HR_USER" } }, { allow: REGISTRATION_DESK_ALLOW, route: "desk" })).not.toBeNull();
  });
});

describe("the role-less caller still passes (API keys are admin-equivalent)", () => {
  // getOrgContext hands this guard `ctx.role ?? undefined`, and an API key has
  // role null. If the inversion had broken this, every key-authenticated write
  // in the application would 403 — the loudest possible regression, pinned here
  // because it is the one case an allow-list is most likely to get wrong.
  it.each([
    ["undefined role", { user: { role: undefined } }],
    ["user with no role", { user: {} }],
    ["session with no user", {}],
    ["null session", null],
  ])("%s passes", (_label, session) => {
    expect(denyReviewer(session as never, { route: "api-key" })).toBeNull();
  });
});

describe("the deliberate change: an unrecognised role fails closed", () => {
  // This is the whole point of G1. Under the deny-list, a role absent from the
  // list could write to every non-HR, non-CRM route; under the allow-list it is
  // refused until someone decides otherwise. It is what will keep a future
  // custom role off every route the permission sweep has not reached.
  it.each(["CUSTOM", "FUTURE_ROLE", "", "  ", "admin", "Admin", "SUPER_ADMIN "])(
    "%s is refused",
    (role) => {
      const denied = denyReviewer({ user: { role } }, { route: "unknown-role" });
      // The empty string is falsy, so it takes the role-less path by design.
      if (role === "") {
        expect(denied).toBeNull();
        return;
      }
      expect(denied).not.toBeNull();
      expect(denied!.status).toBe(403);
    },
  );

  it("is case-sensitive, so a lower-case admin does not slip through", () => {
    expect(denyReviewer({ user: { role: "admin" } }, { route: "case" })).not.toBeNull();
    expect(denyReviewer({ user: { role: "ADMIN" } }, { route: "case" })).toBeNull();
  });
});
