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

import { PERMISSION_CATALOGUE, describePermission, type PermissionKey } from "@/lib/permissions/catalogue";
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS } from "@/lib/permissions/system-roles";
import { can, systemPrincipal, type PersonGrants } from "@/lib/permissions/can";

const ORG = "org-1";
const USER = "user-1";
const ROLES = Object.values(UserRole) as string[];

const principal = (role: string, personGrants?: PersonGrants) =>
  systemPrincipal({ role, organizationId: ORG, userId: USER, personGrants });
const apiKey = () => systemPrincipal({ role: null, organizationId: ORG, userId: null, fromApiKey: true });

describe("HR: the per-person tick on top of the role (§3.4)", () => {
  it("the tick admits any staff role; SUPER_ADMIN and HR_USER carry it by role", () => {
    for (const role of ["ADMIN", "ORGANIZER", "MEMBER", "ONSITE", "WEBINARS", "CRM_USER"]) {
      expect(can(principal(role), "hr.read")).toBe(false);
      expect(can(principal(role, { hrAccess: true }), "hr.read")).toBe(true);
      expect(can(principal(role, { hrAccess: true }), "hr.write")).toBe(true);
    }
    expect(can(principal("SUPER_ADMIN"), "hr.read")).toBe(true);
    expect(can(principal("HR_USER"), "hr.write")).toBe(true);
  });;
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
