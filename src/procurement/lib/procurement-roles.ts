/**
 * Route guard for the Budget & Procurement module (build plan §4.3).
 *
 * Two answers, both logged: 404 when the module is off (the HR shape, so a
 * deployment without the module shows nothing that looks like a feature), 403
 * when the person lacks what the route needs. The `need` names the capability
 * so the log line says WHICH boundary refused, and the route string is a
 * literal so scripts/check-guard-route.sh can hold it to the same rule as
 * denyReviewer.
 *
 * API keys are refused by construction: this guard reads the NextAuth session
 * only, never getOrgContext. The approver's identity is the point of the audit
 * trail and a key has no ceiling (spec §4).
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { isProcurementModuleEnabled } from "@/lib/module-flags";
import {
  canApproveProcurement,
  hasAnyProcurementGrant,
  type ProcurementUserLike,
} from "@/lib/procurement-visibility";
import { can, systemPrincipal, type Principal } from "@/lib/permissions/can";
import { isLivePermissionKey, type PermissionKey } from "@/lib/permissions/catalogue";

export type ProcurementNeed = "view" | "author" | "admin" | "request" | "settle" | "approve" | "propose" | "decide-supplier" | "integration" | "supplier-transfer";

export type ProcurementSession =
  | { user?: ProcurementActorLike | null }
  | null
  | undefined;

/** Does the person hold this permission through a custom role? */
/** The person a procurement route is judging: role, organisation, grants, custom keys. */
export type ProcurementActorLike = ProcurementUserLike & { id?: string | null; organizationId?: string | null };

/**
 * The person as a permission principal, built exactly as `principalFromSession`
 * builds one: the base role's grants, the four legacy person grants (each maps to
 * keys, `LEGACY_PROCUREMENT_GRANTS`), and the live keys of their custom roles.
 * `withCustom: false` leaves the custom roles out, for the two needs the owner
 * fixed to the ROLE alone (linking QuickBooks, bulk supplier transfer).
 */
function procurementPrincipal(user: ProcurementActorLike, withCustom = true): Principal {
  return systemPrincipal({
    role: user.role,
    organizationId: user.organizationId,
    userId: user.id ?? null,
    personGrants: {
      procurementRequest: user.procurementRequest === true,
      procurementSettle: user.procurementSettle === true,
      procurementApproveUnlimited: user.procurementApproveUnlimited === true,
      procurementApproveCeilingAed: user.procurementApproveCeilingAed ?? null,
    },
    customGrants: withCustom ? (user.procurementPermissions ?? []).filter(isLivePermissionKey).map((permission) => ({ permission })) : [],
  });
}

/**
 * May this person do `key` in procurement? The ONE question the server boundary
 * asks (custom roles Phase 2, Oct 5, 2026): `denyNonProcurement` and the route
 * helpers come here. The client-safe predicates in `procurement-visibility.ts`
 * stay for the screens and are pinned to the same keys, for every role and
 * every legacy-grant combination, by system-roles-parity.test.ts.
 */
export function procurementCan(user: ProcurementActorLike | null | undefined, key: PermissionKey, opts: { withCustom?: boolean } = {}): boolean {
  if (!user) return false;
  return can(procurementPrincipal(user, opts.withCustom ?? true), key);
}

const VIEW_KEYS: readonly PermissionKey[] = ["procurement.budgets.view", "procurement.requests.view", "procurement.orders.view", "procurement.suppliers.view"];

function allowed(user: ProcurementActorLike | null | undefined, need: ProcurementNeed, amountAed?: number): boolean {
  if (!user) return false;
  const pc = (key: PermissionKey) => procurementCan(user, key);
  switch (need) {
    case "view":
      // Any custom procurement key at all enters the module; the per-screen
      // keys decide what is visible once inside (as canViewProcurement).
      if (Array.isArray(user.procurementPermissions) && user.procurementPermissions.length > 0) return true;
      return VIEW_KEYS.some(pc);
    case "author":
      return pc("procurement.budgets.create") || pc("procurement.budgets.edit");
    case "admin":
      // THE CATALOGUE: the only routes taking this need are products POST /
      // [productId] / import. D16 makes it permission-only, so the key stands
      // beside the admin key rather than behind it.
      return pc("procurement.catalogue.manage") || pc("procurement.requests.manage");
    case "request":
      return pc("procurement.requests.create");
    case "settle":
      return pc("procurement.budgets.signoff");
    case "propose":
      // A supplier is proposed by a requester or created by the settle holder
      // (spec §4.3), however they hold that power: the propose key, or the
      // request or sign-off key (a custom role may carry those without propose).
      return pc("procurement.suppliers.propose") || pc("procurement.requests.create") || pc("procurement.budgets.signoff");
    case "approve":
      // Two independent questions: MAY they decide (the key, which needs an
      // approval grant on the person, or a legacy ceiling), and HOW MUCH (the
      // AED ceiling on the person, D3). The key alone is not authority.
      if (!pc("procurement.approvals.decide") && !hasAnyProcurementGrant(user)) return false;
      return canApproveProcurement(user, amountAed ?? Number.NaN);
    case "decide-supplier":
      return pc("procurement.suppliers.decide");
    case "integration":
      // Linking the accounting system: ADMIN and SUPER_ADMIN by role only.
      return procurementCan(user, "procurement.integrations.manage", { withCustom: false });
    case "supplier-transfer":
      // Bulk supplier import and export: ADMIN and SUPER_ADMIN by role only.
      return procurementCan(user, "procurement.suppliers.transfer", { withCustom: false });
  }
}

export function denyNonProcurement(
  session: ProcurementSession,
  context: { route: string; need: ProcurementNeed; amountAed?: number },
): NextResponse | null {
  if (!isProcurementModuleEnabled()) {
    apiLogger.warn({
      msg: `${context.route}:procurement-module-disabled`,
      userId: session?.user?.id ?? null,
    });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!session?.user?.id) {
    apiLogger.warn({ msg: `${context.route}:procurement-unauthenticated` });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.user.organizationId) {
    // Org-null roles (reviewer, submitter, registrant) have no organisation to
    // budget for; a grant on such an account is a misconfiguration, not access.
    //
    // UNREACHABLE FROM `procurementGuard` since Sep 16 2026: that caller now
    // resolves the org first (it must, to read custom-role permissions in the
    // right tenant lane before the need is judged), so an org-null caller is
    // refused there with the same 403. Kept because this function is exported
    // and a future direct caller would need it, and because a guard that is
    // correct only by virtue of its callers is one deletion from being wrong.
    apiLogger.warn({
      msg: `${context.route}:procurement-no-org`,
      userId: session.user.id,
      role: session.user.role ?? null,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!allowed(session.user, context.need, context.amountAed)) {
    apiLogger.warn({
      msg: `${context.route}:procurement-forbidden`,
      need: context.need,
      role: session.user.role ?? null,
      userId: session.user.id,
      amountAed: context.amountAed ?? null,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}
