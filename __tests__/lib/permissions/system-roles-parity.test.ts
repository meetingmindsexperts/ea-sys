/**
 * SAFETY NET 1: PREDICATE PARITY (docs/CUSTOM_ROLES_PLAN.md Phase 1, §9).
 *
 * The system roles in system-roles.ts claim to be "the code as it behaves
 * today". This proves it: for every role in the Prisma enum, plus the API key,
 * and for every predicate a route asks today, `can()` on the system role gives
 * the predicate's answer. A cell that drifts, in either file, fails here.
 *
 * The event `where` is checked the same way: `buildEventAccessWhere` per role
 * and surface deep-equals `eventWhereFor` for a key held on that surface, so
 * the scope a role's grants carry is the scope its routes resolve today.
 *
 * What parity cannot prove: that a ROUTE checks the right key. That is safety
 * net 2, the route status matrix, built with the first swept domain.
 *
 * BLIND SPOTS, stated so nobody reads a green run as more than it is:
 *  - About half the keys appear in no row: every plain `*.read` and most
 *    per-domain writes are decided by a route's own guard, not a predicate.
 *    Those cells are the matrix's best reading of the routes (recorded in
 *    plan §5) and are pinned by the Phase 2 route matrix before a sweep.
 *  - Predicate rows pass no event, so a role holding a key at the WRONG scope
 *    passes them; only the `where` block below checks scopes, on three keys.
 *  - A few `old` closures are the matrix's modelling, not the route: the
 *    users routes gate invites on `canWrite` and bound ORGANIZER to ONSITE
 *    accounts, modelled as `events.staff.assign`; `denyNonRoleAdmin` also
 *    refuses a no-org caller, which every principal here has.
 *  - Every staff role lists `hr.read`/`hr.write`, so the HR block proves the
 *    person-grant gate, not a difference between roles: `canViewHr` has none.
 */
import { describe, it, expect } from "vitest";
import { UserRole } from "@prisma/client";

import { REGISTRATION_DESK_ALLOW, WEBINAR_STAFF_ALLOW, WRITE_ROLES } from "@/lib/auth-guards";
import { isOrgAdmin } from "@/lib/team-roles";
import { canWrite } from "@/lib/can-write";
import { canViewFinance } from "@/lib/finance-visibility";
import { canViewEntryBarcode } from "@/lib/barcode-visibility";
import { canExportContacts, canViewContacts } from "@/lib/contact-visibility";
import { canExportRegistrations } from "@/lib/registration-export-visibility";
import { canViewLoginActivity } from "@/lib/login-visibility";
import { canViewSupportingDocument } from "@/lib/supporting-document-visibility";
import { canViewZoomHostCredentials } from "@/lib/zoom-visibility";
import { canManageReimbursements } from "@/lib/reimbursement/constants";
import { canManageTravelGrants } from "@/lib/travel-grant/constants";
import { canUseAgent } from "@/lib/agent/agent-roles";
import { canViewHr, canWriteHr } from "@/lib/hr-visibility";
import {
  canAdminProcurement,
  canApproveProcurement,
  canAuthorBudgets,
  canDecideSuppliers,
  canManageAccountingIntegration,
  canRequestProcurement,
  canSettleProcurement,
  canTransferSuppliers,
  canViewProcurement,
  canViewSupplierFinancials,
  hasAnyProcurementGrant,
} from "@/lib/procurement-visibility";
import {
  canDeleteCrm,
  canExportCrm,
  canManageCrmQuoteDefaults,
  canOwnDeals,
  canPurgeCrm,
  canViewCrm,
  canViewCrmInbox,
  canViewDealValues,
} from "@/crm/lib/crm-roles";
import { accessUserFrom, buildEventAccessWhere } from "@/lib/event-access";

import { PERMISSION_CATALOGUE, describePermission, type PermissionKey } from "@/lib/permissions/catalogue";
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS, systemRoleFor } from "@/lib/permissions/system-roles";
import { can, eventWhereFor, systemPrincipal, type PersonGrants } from "@/lib/permissions/can";
import { API_KEY_FIELD_PERMISSIONS, REST_API_KEY_PERMISSIONS, TOOL_PERMISSIONS } from "@/lib/permissions/tool-permissions";

/**
 * What a key reaches: the tool map plus the key-capable REST routes plus the
 * field keys (api-key-reach.test.ts proves the map covers the registry). The
 * write tiers below take their key column from this, never from "a key is an
 * admin": `certificates.issue` is WRITE_ROLES on a session-only route, so a
 * key holds it nowhere.
 */
const KEY_REACH = new Set<string>([
  ...Object.values(TOOL_PERMISSIONS),
  ...REST_API_KEY_PERMISSIONS.map((r) => r.permission),
  ...API_KEY_FIELD_PERMISSIONS,
]);

const ORG = "org-1";
const USER = "user-1";
const ROLES = Object.values(UserRole) as string[];
const STAFF = ROLES.filter((r) => systemRoleFor(r) !== null);

const principal = (role: string, personGrants?: PersonGrants) =>
  systemPrincipal({ role, organizationId: ORG, userId: USER, personGrants });
const apiKey = () => systemPrincipal({ role: null, organizationId: ORG, userId: null, fromApiKey: true });

/** One row: the predicate a route asks today, and the key that replaces it. `old` takes (role, isApiKey). */
interface Row {
  predicate: string;
  keys: PermissionKey[];
  old: (role: string | null, isApiKey: boolean) => boolean;
}

const has = (list: readonly string[], role: string | null) => !!role && list.includes(role);
/** The key a row is being evaluated for; set by the loop below so a row's `old` can consult KEY_REACH. */
let currentKey: PermissionKey = "events.read";

const ROWS: Row[] = [
  // The three write tiers (ROLES_AND_PERMISSIONS §2). A key is admin-equivalent on writes.
  { predicate: "WRITE_ROLES, no allow-list", keys: ["events.delete", "payments.refund", "certificates.issue"], old: (r, k) => (k ? KEY_REACH.has(currentKey) : has(WRITE_ROLES, r)) },
  { predicate: "REGISTRATION_DESK_ALLOW", keys: ["registrations.checkin", "payments.record", "registrations.create"], old: (r, k) => (k ? KEY_REACH.has(currentKey) : has(WRITE_ROLES, r) || has(REGISTRATION_DESK_ALLOW, r)) },
  { predicate: "WEBINAR_STAFF_ALLOW", keys: ["sessions.write", "communications.send", "tickets.write", "webinar.manage", "events.create"], old: (r, k) => (k ? KEY_REACH.has(currentKey) : has(WRITE_ROLES, r) || has(WEBINAR_STAFF_ALLOW, r)) },
  // Field visibility (§4). Finance redaction runs only for a session role outside the set, so a key sees amounts.
  { predicate: "canViewFinance", keys: ["finance.view"], old: (r, k) => k || canViewFinance(r) },
  { predicate: "canViewEntryBarcode", keys: ["barcode.view"], old: (r, k) => canViewEntryBarcode(r, k) },
  { predicate: "canExportRegistrations", keys: ["registrations.export"], old: (r, k) => canExportRegistrations(r, k) },
  { predicate: "canViewZoomHostCredentials", keys: ["zoomHost.view"], old: (r, k) => canViewZoomHostCredentials(r, k) },
  { predicate: "canViewSupportingDocument", keys: ["supportingDocs.view"], old: (r, k) => !k && canViewSupportingDocument(r) },
  { predicate: "canViewLoginActivity", keys: ["loginActivity.read"], old: (r, k) => !k && canViewLoginActivity(r) },
  { predicate: "canManageReimbursements", keys: ["reimbursements.manage", "honorarium.manage", "honorarium.view"], old: (r, k) => !k && canManageReimbursements(r) },
  { predicate: "canManageTravelGrants", keys: ["travelGrants.manage"], old: (r, k) => !k && canManageTravelGrants(r) },
  { predicate: "canViewContacts", keys: ["contacts.read"], old: (r, k) => canViewContacts(r, k) },
  { predicate: "canExportContacts", keys: ["contacts.export"], old: (r, k) => canExportContacts(r, k) },
  // CRM (§7.1)
  { predicate: "canViewCrm", keys: ["crm.read"], old: (r, k) => canViewCrm(r, k) },
  { predicate: "canOwnDeals", keys: ["crm.write"], old: (r, k) => canOwnDeals(r, k) },
  { predicate: "canViewCrmInbox", keys: ["crm.inbox.read"], old: (r, k) => canViewCrmInbox(r, k) },
  { predicate: "canViewDealValues", keys: ["crm.dealValues.view"], old: (r, k) => canViewDealValues(r, k) },
  { predicate: "canDeleteCrm", keys: ["crm.delete"], old: (r, k) => canDeleteCrm(r, k) },
  { predicate: "canExportCrm", keys: ["crm.export"], old: (r, k) => canExportCrm(r, k) },
  { predicate: "canManageCrmQuoteDefaults", keys: ["crm.quoteDefaults.manage"], old: (r, k) => canManageCrmQuoteDefaults(r, k) },
  { predicate: "canPurgeCrm", keys: ["crm.purge"], old: (r, k) => canPurgeCrm(r, k) },
  // Organisation (§6): session-only surfaces, so a key is refused.
  { predicate: "canUseAgent", keys: ["agent.use"], old: (r, k) => !k && canUseAgent(r) },
  { predicate: "canWrite (event activity)", keys: ["activity.read"], old: (r, k) => !k && canWrite(r) },
  // MCP consent left canWrite on Oct 6, 2026 (owner): admins only.
  { predicate: "MCP consent (admins)", keys: ["mcp.connect"], old: (r, k) => !k && isOrgAdmin(r) },
  { predicate: "isOrgAdmin (denyNonOrgAdmin)", keys: ["org.settings", "org.credentials", "apiKeys.manage", "activity.org.read", "users.manage", "users.invite"], old: (r, k) => !k && isOrgAdmin(r) },
  { predicate: "denyNonRoleAdmin (SUPER_ADMIN)", keys: ["roles.manage"], old: (r, k) => !k && r === "SUPER_ADMIN" },
];

describe("safety net 1: every predicate, every role, the same answer from can()", () => {
  for (const row of ROWS) {
    describe(row.predicate, () => {
      for (const key of row.keys) {
        it.each(ROLES)(`${key} for %s`, (role) => {
          currentKey = key;
          expect(can(principal(role), key)).toBe(row.old(role, false));
        });
        it(`${key} for an API key`, () => {
          currentKey = key;
          expect(can(apiKey(), key)).toBe(row.old(null, true));
        });
      }
    });
  }
});

describe("HR: the per-person tick on top of the role (§3.4)", () => {
  // Staff only: `canViewHr` reads the tick on any role, but an org-null account
  // never reaches the org-scoped module, so parity is stated for staff.
  it.each(STAFF)("%s with and without HR access", (role) => {
    for (const hrAccess of [false, true]) {
      const user = { role, hrAccess };
      expect(can(principal(role, { hrAccess }), "hr.read")).toBe(canViewHr(user));
      expect(can(principal(role, { hrAccess }), "hr.write")).toBe(canWriteHr(user));
    }
  });
  it("is refused to an API key", () => {
    expect(can(apiKey(), "hr.read")).toBe(false);
  });
});

/** The legacy procurement columns, every combination a person can be in. */
const PROCUREMENT_GRANT_COMBOS: { label: string; grants: PersonGrants }[] = [
  { label: "no grant", grants: {} },
  { label: "request", grants: { procurementRequest: true } },
  { label: "settle", grants: { procurementSettle: true } },
  { label: "ceiling 5000", grants: { procurementApproveCeilingAed: 5000 } },
  { label: "unlimited", grants: { procurementApproveUnlimited: true } },
  { label: "request + ceiling", grants: { procurementRequest: true, procurementApproveCeilingAed: 5000 } },
];

describe("procurement: role sets, person grants and the transition arm (§7.3)", () => {
  const rows: { predicate: string; keys: PermissionKey[]; old: (u: { role: string } & PersonGrants) => boolean }[] = [
    { predicate: "canViewProcurement", keys: ["procurement.budgets.view", "procurement.requests.view", "procurement.orders.view", "procurement.suppliers.view"], old: canViewProcurement },
    { predicate: "canAuthorBudgets", keys: ["procurement.budgets.create", "procurement.budgets.edit", "procurement.budgets.discard"], old: canAuthorBudgets },
    { predicate: "canAdminProcurement", keys: ["procurement.requests.manage"], old: canAdminProcurement },
    { predicate: "canManageAccountingIntegration", keys: ["procurement.integrations.manage"], old: canManageAccountingIntegration },
    { predicate: "canTransferSuppliers", keys: ["procurement.suppliers.transfer"], old: canTransferSuppliers },
    { predicate: "canRequestProcurement", keys: ["procurement.requests.create"], old: canRequestProcurement },
    { predicate: "canSettleProcurement", keys: ["procurement.budgets.signoff", "procurement.suppliers.edit"], old: canSettleProcurement },
    // commitment-service, not a predicate: who acts on an order. The requester
    // acts on their OWN order only, a row rule the key cannot carry; here the
    // request holder is compared as if on their own order.
    { predicate: "commitment-service actsOnOrder (send, receive)", keys: ["procurement.orders.send", "procurement.orders.receive"], old: (u) => canAdminProcurement(u) || canSettleProcurement(u) || canRequestProcurement(u) },
    { predicate: "commitment-service cancel", keys: ["procurement.orders.cancel"], old: (u) => canAdminProcurement(u) || canSettleProcurement(u) },
    { predicate: "commitment-service confirm large receipt", keys: ["procurement.orders.confirmReceipt"], old: (u) => canSettleProcurement(u) || canApproveProcurement(u, 0) },
    { predicate: "canDecideSuppliers", keys: ["procurement.suppliers.decide"], old: canDecideSuppliers },
    { predicate: "canViewSupplierFinancials", keys: ["procurement.suppliers.financials.view"], old: canViewSupplierFinancials },
    { predicate: "propose (request or settle)", keys: ["procurement.suppliers.propose"], old: (u) => canRequestProcurement(u) || canSettleProcurement(u) },
    {
      predicate: "approve (a ceiling above zero)",
      keys: ["procurement.approvals.decide"],
      old: (u) => hasAnyProcurementGrant(u) && canApproveProcurement(u, 1),
    },
  ];
  for (const row of rows) {
    describe(row.predicate, () => {
      for (const key of row.keys) {
        for (const combo of PROCUREMENT_GRANT_COMBOS) {
          it.each(ROLES)(`${key}, ${combo.label}, %s`, (role) => {
            expect(can(principal(role, combo.grants), key)).toBe(row.old({ role, ...combo.grants }));
          });
        }
        it(`${key} is refused to an API key`, () => {
          expect(can(apiKey(), key)).toBe(false);
        });
      }
    });
  }
});

describe("the event where: buildEventAccessWhere per role and surface equals eventWhereFor", () => {
  const DESK_KEY: PermissionKey = "registrations.checkin";
  const MANAGE_KEY: PermissionKey = "sessions.write";
  const READ_KEY: PermissionKey = "events.read";

  for (const eventId of [undefined, "ev-1"]) {
    describe(eventId ? "for one event" : "for the list", () => {
      it.each(STAFF)("%s: the desk surface", (role) => {
        const p = principal(role);
        const old = buildEventAccessWhere({ id: USER, role, organizationId: ORG }, eventId, { surface: "desk" });
        for (const key of [DESK_KEY, READ_KEY]) {
          if (can(p, key)) expect(eventWhereFor(p, key, eventId), key).toEqual(old);
          else expect(eventWhereFor(p, key, eventId), key).toEqual({ id: { in: [] } });
        }
      });

      it.each(STAFF)("%s: the manage surface", (role) => {
        const p = principal(role);
        const old = buildEventAccessWhere({ id: USER, role, organizationId: ORG }, eventId);
        if (can(p, MANAGE_KEY)) expect(eventWhereFor(p, MANAGE_KEY, eventId)).toEqual(old);
        else expect(eventWhereFor(p, MANAGE_KEY, eventId)).toEqual({ id: { in: [] } });
      });

      it("an API key resolves every event in its organisation", () => {
        const old = buildEventAccessWhere(accessUserFrom({ organizationId: ORG, userId: null, role: null }), eventId);
        expect(eventWhereFor(apiKey(), "registrations.read", eventId)).toEqual(old);
      });

      it("the platform operator (SUPER_ADMIN with no org) resolves every event", () => {
        const p = systemPrincipal({ role: "SUPER_ADMIN", organizationId: null, userId: USER });
        const old = buildEventAccessWhere({ id: USER, role: "SUPER_ADMIN", organizationId: null }, eventId);
        expect(eventWhereFor(p, "events.read", eventId)).toEqual(old);
      });
    });
  }

  it("WEBINARS: the desk everywhere, control on webinars only, in the same request", () => {
    const p = principal("WEBINARS");
    expect(eventWhereFor(p, DESK_KEY)).toEqual({ organizationId: ORG });
    expect(eventWhereFor(p, MANAGE_KEY)).toEqual({ organizationId: ORG, eventType: "WEBINAR" });
  });
});

describe("the matrix itself", () => {
  const allGrants = SYSTEM_ROLE_KEYS.flatMap((k) => SYSTEM_ROLES[k].grants.map((g) => ({ role: k, ...g })));

  it("grants only catalogue keys, with a scope exactly when the key is event-bound", () => {
    for (const g of allGrants) {
      const d = describePermission(g.permission);
      expect(d, `${g.role} grants unknown key ${g.permission}`).toBeDefined();
      expect(g.scope !== undefined, `${g.role}: ${g.permission} scope`).toBe(d?.eventBound === true);
    }
  });

  it("holds no (permission, scope) pair twice on one role", () => {
    for (const k of SYSTEM_ROLE_KEYS) {
      const pairs = SYSTEM_ROLES[k].grants.map((g) => `${g.permission}@${g.scope ?? ""}`);
      expect(new Set(pairs).size, k).toBe(pairs.length);
    }
  });

  it("every catalogue key is held by some system role, except the grant-only procurement keys", () => {
    const held = new Set(allGrants.map((g) => g.permission));
    const unheld = PERMISSION_CATALOGUE.map((p) => p.key).filter((k) => !held.has(k)).sort();
    // Held by nobody BY ROLE: the person's grants or a custom role carry them
    // (PROCUREMENT_ROLES_PLAN: the super admin is never an approver, the final
    // approver never requests, settlement is a named person).
    expect(unheld).toEqual([
      "procurement.approvals.decide",
      "procurement.budgets.signoff",
      "procurement.orders.confirmReceipt",
      "procurement.requests.create",
      "procurement.suppliers.edit",
      "procurement.suppliers.propose",
    ]);
  });

  it("SUPER_ADMIN holds everything ADMIN holds, ADMIN everything ORGANIZER holds", () => {
    const pairs = (k: keyof typeof SYSTEM_ROLES) => new Set(SYSTEM_ROLES[k].grants.map((g) => `${g.permission}@${g.scope ?? ""}`));
    const sa = pairs("SUPER_ADMIN");
    const admin = pairs("ADMIN");
    for (const p of admin) expect(sa.has(p), p).toBe(true);
    for (const p of pairs("ORGANIZER")) expect(admin.has(p), p).toBe(true);
  });

  it("the plan's recorded differences from the docs hold in the data (§7.6)", () => {
    // ORGANIZER is org-wide (never "assigned events only").
    expect(SYSTEM_ROLES.ORGANIZER.grants.every((g) => g.scope === undefined || g.scope === "ALL")).toBe(true);
    // abstracts.delete is SUPER_ADMIN's alone; registrations.delete is never a desk power (L-4).
    expect(can(principal("ADMIN"), "abstracts.delete")).toBe(false);
    expect(can(principal("WEBINARS"), "registrations.delete")).toBe(false);
    // MEMBER reads money but never codes, exports or supporting documents.
    expect(can(principal("MEMBER"), "finance.view")).toBe(true);
    for (const k of ["barcode.view", "registrations.export", "supportingDocs.view", "rsvp.roster.read"] as PermissionKey[]) {
      expect(can(principal("MEMBER"), k), k).toBe(false);
    }
  });
});
