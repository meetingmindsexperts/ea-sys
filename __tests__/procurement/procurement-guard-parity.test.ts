/**
 * The procurement guard asks `can()` since custom roles Phase 2 (Oct 5, 2026).
 * This pins it to the rules it replaced, need by need: for every role, every
 * combination of the four legacy person grants, a spread of custom-role key
 * sets and a range of approval amounts, `denyNonProcurement` must refuse
 * exactly when the old switch (rebuilt below from the client-safe predicates
 * it used to call) refused.
 *
 * The route status matrix cannot show this: its callers carry roles only.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { denyNonProcurement, procurementCan, type ProcurementNeed } from "@/procurement/lib/procurement-roles";
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
  type ProcurementUserLike,
} from "@/lib/procurement-visibility";
import { canViewFinance } from "../helpers/role-can";

/** The guard's switch as it stood before the sweep: the oracle. */
function oldAllowed(user: ProcurementUserLike, need: ProcurementNeed, amountAed?: number): boolean {
  const holdsKey = (key: string) => Array.isArray(user.procurementPermissions) && user.procurementPermissions.includes(key);
  switch (need) {
    case "view":
      return canViewProcurement(user);
    case "author":
      return canAuthorBudgets(user);
    case "admin":
      return holdsKey("procurement.catalogue.manage") || canAdminProcurement(user);
    case "request":
      return canRequestProcurement(user);
    case "settle":
      return canSettleProcurement(user);
    case "propose":
      return holdsKey("procurement.suppliers.propose") || canRequestProcurement(user) || canSettleProcurement(user);
    case "approve":
      if (!holdsKey("procurement.approvals.decide") && !hasAnyProcurementGrant(user)) return false;
      return canApproveProcurement(user, amountAed ?? Number.NaN);
    case "decide-supplier":
      return canDecideSuppliers(user);
    case "integration":
      return canManageAccountingIntegration(user);
    case "supplier-transfer":
      return canTransferSuppliers(user);
  }
}

const ROLES = ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER", "ONSITE", "WEBINARS", "CRM_USER", "HR_USER"];
const NEEDS: ProcurementNeed[] = ["view", "author", "admin", "request", "settle", "approve", "propose", "decide-supplier", "integration", "supplier-transfer"];
const AMOUNTS = [undefined, 0, 1, 4_999, 5_000, 5_001, 1_000_000];

const GRANT_COMBOS: Partial<ProcurementUserLike>[] = [];
for (const procurementRequest of [false, true])
  for (const procurementSettle of [false, true])
    for (const ceiling of [null, 0, 5_000])
      for (const procurementApproveUnlimited of [false, true])
        GRANT_COMBOS.push({ procurementRequest, procurementSettle, procurementApproveCeilingAed: ceiling, procurementApproveUnlimited });

const CUSTOM_KEY_SETS: (string[] | undefined)[] = [
  undefined,
  [],
  ["procurement.budgets.view"],
  ["procurement.requests.create"],
  ["procurement.requests.manage"],
  ["procurement.catalogue.manage"],
  ["procurement.budgets.create"],
  ["procurement.budgets.signoff"],
  ["procurement.suppliers.propose"],
  ["procurement.suppliers.decide"],
  ["procurement.approvals.decide"],
  ["procurement.integrations.manage", "procurement.suppliers.transfer"],
  ["procurement.requests.view", "procurement.orders.view", "procurement.requests.create", "procurement.approvals.decide"],
];

/** The route-level checks the sweep moved onto `procurementCan`, with the predicate each replaced. */
const ROUTE_CHECKS = [
  { key: "procurement.requests.manage", old: (u: ProcurementUserLike) => canAdminProcurement(u) },
  { key: "procurement.requests.create", old: (u: ProcurementUserLike) => canRequestProcurement(u) },
  { key: "procurement.budgets.signoff", old: (u: ProcurementUserLike) => canSettleProcurement(u) },
  { key: "procurement.suppliers.financials.view", old: (u: ProcurementUserLike) => canViewSupplierFinancials(u) },
  { key: "finance.view", old: (u: ProcurementUserLike) => canViewFinance(u.role) },
] as const;

describe("procurement guard parity: can() against the old switch", () => {
  beforeAll(() => {
    vi.stubEnv("PROCUREMENT_MODULE_ENABLED", "true");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("refuses exactly when the old rules refused, for every role, grant, key set, need and amount", () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const role of ROLES)
      for (const grants of GRANT_COMBOS)
        for (const keys of CUSTOM_KEY_SETS)
          for (const need of NEEDS)
            for (const amountAed of need === "approve" ? AMOUNTS : [undefined]) {
              const user = { id: "u1", organizationId: "org-1", role, ...grants, procurementPermissions: keys };
              const expected = oldAllowed(user, need, amountAed);
              const actual = denyNonProcurement({ user }, { route: "parity", need, amountAed }) === null;
              checked++;
              if (expected !== actual) mismatches.push(`${role} ${JSON.stringify(grants)} keys=${JSON.stringify(keys)} need=${need} amount=${amountAed}: old ${expected}, new ${actual}`);
            }
    expect(checked).toBeGreaterThan(30_000);
    const byNeed = mismatches.reduce<Record<string, number>>((acc, m) => {
      const need = /need=([a-z-]+)/.exec(m)?.[1] ?? "?";
      acc[need] = (acc[need] ?? 0) + 1;
      return acc;
    }, {});
    expect(byNeed).toEqual({});
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it("answers the route-level checks exactly as the predicates they replaced", () => {
    const mismatches: string[] = [];
    for (const role of ROLES)
      for (const grants of GRANT_COMBOS)
        for (const keys of CUSTOM_KEY_SETS)
          for (const check of ROUTE_CHECKS) {
            const user = { id: "u1", organizationId: "org-1", role, ...grants, procurementPermissions: keys };
            if (procurementCan(user, check.key) !== check.old(user)) mismatches.push(`${role} ${JSON.stringify(grants)} keys=${JSON.stringify(keys)} ${check.key}`);
          }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });
});
