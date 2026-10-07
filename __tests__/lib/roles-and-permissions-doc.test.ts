import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole } from "@prisma/client";

import { ASSIGNABLE_USER_ROLES } from "@/lib/auth-guards";
import { TEAM_ROLES } from "@/lib/team-roles";
import { roleCan } from "../helpers/role-can";
import type { PermissionKey } from "@/lib/permissions/catalogue";

/**
 * docs/ROLES_AND_PERMISSIONS.md is the one page that answers "what can this
 * role do". Its §4 table names each boundary by the permission that decides
 * it. This test evaluates every predicate for every role in the Prisma enum
 * and compares the answer to the row in the document, so a guard change
 * that forgets the table fails here rather than being quoted wrongly later
 * (the same rule DATA_EXPORTS.md lives by, now enforced).
 */
const DOC = readFileSync(path.join(process.cwd(), "docs/ROLES_AND_PERMISSIONS.md"), "utf8");
const ROLES = Object.values(UserRole) as string[];

type RolePredicate = (role: string) => boolean;
type ApiKeyPredicate = () => boolean;

/**
 * Since custom roles Phase 6 (Oct 6, 2026) every boundary is a permission
 * key, judged by `can()` for the built-in role (on an event it is assigned to,
 * for an event-bound key; on a conference, so WEBINARS' webinar-only scope
 * reads as "no"). The account-type rows (TEAM_ROLES, ASSIGNABLE_USER_ROLES)
 * stay role lists.
 */
const key = (k: PermissionKey) => ({ roles: (r: string) => roleCan(k, r), apiKey: () => roleCan(k, null, true) });
const PREDICATES: Record<string, { roles: RolePredicate; apiKey?: ApiKeyPredicate }> = {
  "events.update": key("events.update"),
  "registrations.checkin": key("registrations.checkin"),
  "finance.view": key("finance.view"),
  "barcode.view": key("barcode.view"),
  "contacts.read": key("contacts.read"),
  "contacts.export": key("contacts.export"),
  "registrations.export": key("registrations.export"),
  "loginActivity.read": key("loginActivity.read"),
  "supportingDocs.view": key("supportingDocs.view"),
  "zoomHost.view": key("zoomHost.view"),
  "reimbursements.manage": key("reimbursements.manage"),
  "crm.read": key("crm.read"),
  "crm.write": key("crm.write"),
  "crm.dealValues.view": key("crm.dealValues.view"),
  "crm.delete": key("crm.delete"),
  "crm.export": key("crm.export"),
  "crm.quoteDefaults.manage": key("crm.quoteDefaults.manage"),
  "crm.purge": key("crm.purge"),
  TEAM_ROLES: { roles: (r) => (TEAM_ROLES as readonly string[]).includes(r) },
  ASSIGNABLE_USER_ROLES: { roles: (r) => (ASSIGNABLE_USER_ROLES as readonly string[]).includes(r) },
};

/** The §4 row for a predicate: `| boundary | \`name\` | ROLE · ROLE | yes/no/n/a ... |`. */
function rowFor(name: string): { roles: string[]; apiKey: string } {
  const line = DOC.split("\n").find((l) => l.startsWith("|") && l.includes(`\`${name}\``));
  expect(line, `§4 has no row for \`${name}\``).toBeDefined();
  const cells = (line as string).split("|").map((c) => c.trim());
  // cells[0] and the last are the empty strings outside the outer pipes.
  const roles = cells[3].split("·").map((r) => r.trim()).filter(Boolean);
  const apiKey = cells[4].split(/\s+/)[0].toLowerCase();
  return { roles, apiKey };
}

describe("docs/ROLES_AND_PERMISSIONS.md matches the code", () => {
  it("names every role in the Prisma enum, and no other", () => {
    for (const role of ROLES) {
      expect(DOC, `role ${role} is missing from §1`).toContain(`**${role}**`);
    }
    // A role added to the enum without a row in §1 fails above; a row for a
    // role the enum no longer has fails here.
    const bolded = [...DOC.matchAll(/\| \*\*([A-Z_]+)\*\* \|/g)].map((m) => m[1]);
    for (const name of bolded) {
      expect(ROLES, `§1 names ${name}, which is not a UserRole`).toContain(name);
    }
  });

  for (const [name, predicate] of Object.entries(PREDICATES)) {
    it(`§4 row for ${name} lists exactly the roles the code admits`, () => {
      const row = rowFor(name);
      const fromCode = ROLES.filter((r) => predicate.roles(r)).sort();
      expect(row.roles.slice().sort(), `roles for ${name}`).toEqual(fromCode);
      for (const r of row.roles) {
        expect(ROLES, `${name} row names ${r}, which is not a UserRole`).toContain(r);
      }
      if (predicate.apiKey) {
        const expected = predicate.apiKey() ? "yes" : "no";
        expect(row.apiKey, `API-key column for ${name}`).toBe(expected);
      }
    });
  }

  it("every §4 row with a backticked predicate is one this test knows", () => {
    const section = DOC.slice(DOC.indexOf("## 4."), DOC.indexOf("## 5."));
    const named = [...section.matchAll(/^\| [^|]+ \| `([A-Za-z_.]+)` \|/gm)].map((m) => m[1]);
    for (const name of named) {
      expect(Object.keys(PREDICATES), `§4 names \`${name}\` but the test has no predicate for it`).toContain(name);
    }
  });
});
