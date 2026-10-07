/**
 * Every built-in role's grants, frozen (custom roles Phase 6, Oct 6, 2026).
 *
 * Until Phase 6 the parity test proved each old role predicate and `can()`
 * gave the same answer. Phase 6 deletes the old predicates, so the guarantee
 * moves here: what each built-in role may do is this snapshot, and any change
 * to it is a reviewed snapshot change, never a side effect. Regenerate only on
 * purpose (`npx vitest run -u` on this file) and read the diff.
 */
import { describe, it, expect } from "vitest";
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS } from "@/lib/permissions/system-roles";

describe("built-in role grants", () => {
  for (const key of SYSTEM_ROLE_KEYS) {
    it(key, () => {
      const role = SYSTEM_ROLES[key];
      expect({
        baseRole: role.baseRole,
        grants: role.grants.map((g) => (g.scope ? `${g.permission}@${g.scope}` : g.permission)).sort(),
        areas: role.areas.map((a) => (a.scope ? `${a.area}@${a.scope}` : a.area)).sort(),
        impliedPersonGrants: [...role.impliedPersonGrants].sort(),
      }).toMatchSnapshot();
    });
  }
});

/**
 * The visibility boundaries the old predicates named (finance, barcodes,
 * contacts, exports, sign-in activity, supporting documents, Zoom host
 * credentials, the agent, HR, the CRM), answered by `can()` per role and for
 * an API key. These were the truth tables of canViewFinance, canViewEntryBarcode,
 * canViewContacts and the rest, deleted in Phase 6; this table replaces them.
 */
import { can, principalFromUser } from "@/lib/permissions/can";
import { principalFromApiKey } from "@/lib/permissions/require-permission";

const BOUNDARY_KEYS = [
  "finance.view",
  "barcode.view",
  "contacts.read",
  "contacts.export",
  "registrations.export",
  "activity.org.read",
  "supportingDocs.view",
  "zoomHost.view",
  "honorarium.view",
  "agent.use",
  "hr.read",
  "hr.write",
  "crm.read",
  "crm.write",
  "crm.dealValues.view",
  "crm.inbox.read",
  "crm.delete",
  "crm.export",
  "crm.purge",
  "users.manage",
  "org.settings",
] as const;
const event = { organizationId: "o", eventType: "CONFERENCE", staffUserIds: ["u"] };

describe("visibility boundaries by role", () => {
  it("answers each boundary per built-in role (with and without the HR tick) and for an API key", () => {
    const rows: Record<string, string> = {};
    const principals: [string, ReturnType<typeof principalFromUser>][] = [
      ...SYSTEM_ROLE_KEYS.filter((k) => SYSTEM_ROLES[k].baseRole).map(
        (k) => [k, principalFromUser({ id: "u", role: SYSTEM_ROLES[k].baseRole, organizationId: "o" })] as [string, ReturnType<typeof principalFromUser>],
      ),
      ["ADMIN+hrAccess", principalFromUser({ id: "u", role: "ADMIN", organizationId: "o", hrAccess: true })],
      ["API_KEY", principalFromApiKey("o")],
    ];
    for (const [name, p] of principals) {
      rows[name] = BOUNDARY_KEYS.filter((k) => can(p, k, { event })).join(" ");
    }
    expect(rows).toMatchSnapshot();
  });
});
