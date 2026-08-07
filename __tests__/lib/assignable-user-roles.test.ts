/**
 * The invite door and the change-role door must agree on which roles exist.
 *
 * They didn't: inviting someone AS Webinars worked, while moving an existing
 * member TO Webinars failed validation, because the two routes kept separate
 * hand-written lists and one fell four roles behind. Both now derive from
 * ASSIGNABLE_USER_ROLES; these pin the properties that matter.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { ASSIGNABLE_USER_ROLES, TEAM_ROLES } from "@/lib/auth-guards";

describe("assignable user roles", () => {
  it("covers every team role except SUPER_ADMIN", () => {
    for (const role of TEAM_ROLES) {
      if (role === "SUPER_ADMIN") continue;
      expect(
        ASSIGNABLE_USER_ROLES as readonly string[],
        `${role} is a team role but cannot be assigned`,
      ).toContain(role);
    }
  });

  it("never allows granting SUPER_ADMIN through an admin surface", () => {
    // Privilege escalation: an org admin must not be able to mint a
    // platform-wide super admin from the users dialog.
    expect(ASSIGNABLE_USER_ROLES as readonly string[]).not.toContain("SUPER_ADMIN");
  });

  it("includes REVIEWER, which is invited through the same door", () => {
    // Not a team role (org-independent), but assigned here in practice.
    expect(ASSIGNABLE_USER_ROLES as readonly string[]).toContain("REVIEWER");
  });

  it("includes the roles that were previously un-assignable", () => {
    // The reported bug: moving a user to Webinars 400'd. MEMBER, ONSITE and
    // CRM_USER were in the same gap.
    for (const role of ["WEBINARS", "MEMBER", "ONSITE", "CRM_USER"]) {
      expect(ASSIGNABLE_USER_ROLES as readonly string[]).toContain(role);
    }
  });

  it("both routes derive from the shared list rather than re-declaring one", () => {
    // The root cause was two hand-written lists. A literal z.enum([...]) of
    // role strings in either route means they can drift again.
    for (const file of [
      "src/app/api/organization/users/route.ts",
      "src/app/api/organization/users/[userId]/route.ts",
    ]) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} should use the shared list`).toContain(
        "z.enum(ASSIGNABLE_USER_ROLES)",
      );
      expect(
        /role:\s*z\.enum\(\s*\[/.test(src),
        `${file} re-declares its own role list`,
      ).toBe(false);
    }
  });
});
