import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole } from "@prisma/client";

import {
  ASSIGNABLE_USER_ROLES,
  REGISTRATION_DESK_ALLOW,
  WEBINAR_STAFF_ALLOW,
  WRITE_ROLES,
} from "@/lib/auth-guards";
import { TEAM_ROLES } from "@/lib/team-roles";
import { canWrite } from "@/lib/can-write";
import { canViewFinance } from "@/lib/finance-visibility";
import { canViewEntryBarcode } from "@/lib/barcode-visibility";
import { canExportContacts, canViewContacts } from "@/lib/contact-visibility";
import { canExportRegistrations } from "@/lib/registration-export-visibility";
import { canViewLoginActivity } from "@/lib/login-visibility";
import { canViewSupportingDocument } from "@/lib/supporting-document-visibility";
import { canViewZoomHostCredentials } from "@/lib/zoom-visibility";
import { canManageReimbursements } from "@/lib/reimbursement/constants";
import {
  canDeleteCrm,
  canExportCrm,
  canManageCrmQuoteDefaults,
  canOwnDeals,
  canPurgeCrm,
  canViewCrm,
  canViewDealValues,
} from "@/crm/lib/crm-roles";

/**
 * docs/ROLES_AND_PERMISSIONS.md is the one page that answers "what can this
 * role do". Its §4 table names each boundary by the predicate that decides
 * it. This test evaluates every predicate for every role in the Prisma enum
 * and compares the answer to the row in the document, so a guard change
 * that forgets the table fails here rather than being quoted wrongly later
 * (the same rule DATA_EXPORTS.md lives by, now enforced).
 */
const DOC = readFileSync(path.join(process.cwd(), "docs/ROLES_AND_PERMISSIONS.md"), "utf8");
const ROLES = Object.values(UserRole) as string[];

type RolePredicate = (role: string) => boolean;
type ApiKeyPredicate = () => boolean;

const PREDICATES: Record<string, { roles: RolePredicate; apiKey?: ApiKeyPredicate }> = {
  WRITE_ROLES: { roles: (r) => (WRITE_ROLES as readonly string[]).includes(r) },
  REGISTRATION_DESK_ALLOW: { roles: (r) => (REGISTRATION_DESK_ALLOW as readonly string[]).includes(r) },
  WEBINAR_STAFF_ALLOW: { roles: (r) => (WEBINAR_STAFF_ALLOW as readonly string[]).includes(r) },
  canWrite: { roles: (r) => canWrite(r) },
  canViewFinance: { roles: (r) => canViewFinance(r) },
  canViewEntryBarcode: { roles: (r) => canViewEntryBarcode(r, false), apiKey: () => canViewEntryBarcode(null, true) },
  canViewContacts: { roles: (r) => canViewContacts(r, false), apiKey: () => canViewContacts(null, true) },
  canExportContacts: { roles: (r) => canExportContacts(r, false), apiKey: () => canExportContacts(null, true) },
  canExportRegistrations: {
    roles: (r) => canExportRegistrations(r, false),
    apiKey: () => canExportRegistrations(null, true),
  },
  canViewLoginActivity: { roles: (r) => canViewLoginActivity(r), apiKey: () => canViewLoginActivity(null) },
  canViewSupportingDocument: {
    roles: (r) => canViewSupportingDocument(r),
    apiKey: () => canViewSupportingDocument(null),
  },
  canViewZoomHostCredentials: {
    roles: (r) => canViewZoomHostCredentials(r, false),
    apiKey: () => canViewZoomHostCredentials(null, true),
  },
  canManageReimbursements: { roles: (r) => canManageReimbursements(r), apiKey: () => canManageReimbursements(null) },
  canViewCrm: { roles: (r) => canViewCrm(r, false), apiKey: () => canViewCrm(null, true) },
  canOwnDeals: { roles: (r) => canOwnDeals(r, false), apiKey: () => canOwnDeals(null, true) },
  canViewDealValues: { roles: (r) => canViewDealValues(r, false), apiKey: () => canViewDealValues(null, true) },
  canDeleteCrm: { roles: (r) => canDeleteCrm(r, false), apiKey: () => canDeleteCrm(null, true) },
  canExportCrm: { roles: (r) => canExportCrm(r, false), apiKey: () => canExportCrm(null, true) },
  canManageCrmQuoteDefaults: {
    roles: (r) => canManageCrmQuoteDefaults(r, false),
    apiKey: () => canManageCrmQuoteDefaults(null, true),
  },
  canPurgeCrm: { roles: (r) => canPurgeCrm(r, false), apiKey: () => canPurgeCrm(null, true) },
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
    const named = [...section.matchAll(/^\| [^|]+ \| `([A-Za-z_]+)` \|/gm)].map((m) => m[1]);
    for (const name of named) {
      expect(Object.keys(PREDICATES), `§4 names \`${name}\` but the test has no predicate for it`).toContain(name);
    }
  });
});
