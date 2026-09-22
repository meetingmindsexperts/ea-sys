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
  canAdminProcurement,
  canApproveProcurement,
  canAuthorBudgets,
  canDecideSuppliers,
  canManageAccountingIntegration,
  canRequestProcurement,
  canSettleProcurement,
  canViewProcurement,
  hasAnyProcurementGrant,
  type ProcurementUserLike,
} from "@/lib/procurement-visibility";

export type ProcurementNeed = "view" | "author" | "admin" | "request" | "settle" | "approve" | "propose" | "decide-supplier" | "integration";

export type ProcurementSession =
  | { user?: (ProcurementUserLike & { id?: string; organizationId?: string | null }) | null }
  | null
  | undefined;

/** Does the person hold this permission through a custom role? */
function holdsKey(user: ProcurementUserLike | null | undefined, key: string): boolean {
  const keys = user?.procurementPermissions;
  return Array.isArray(keys) && keys.includes(key);
}

function allowed(user: ProcurementUserLike | null | undefined, need: ProcurementNeed, amountAed?: number): boolean {
  switch (need) {
    case "view":
      return canViewProcurement(user);
    case "author":
      return canAuthorBudgets(user);
    case "admin":
      // THE CATALOGUE, and nothing else: the only routes taking this need are
      // products POST / [productId] / import. D16 makes it permission-only, so
      // the key stands beside the role rather than behind `canAdminProcurement`,
      // whose eight other call sites mean "act on someone else's request".
      return holdsKey(user, "procurement.catalogue.manage") || canAdminProcurement(user);
    case "request":
      return canRequestProcurement(user);
    case "settle":
      return canSettleProcurement(user);
    case "propose":
      // A supplier is proposed by a requester or created by the settle holder (spec §4.3).
      return holdsKey(user, "procurement.suppliers.propose") || canRequestProcurement(user) || canSettleProcurement(user);
    case "approve":
      // Two independent questions: MAY they decide (the key or a legacy
      // ceiling), and HOW MUCH (the AED ceiling on the person, D3). Holding
      // the key alone is not authority; a ceiling is still required.
      if (!holdsKey(user, "procurement.approvals.decide") && !hasAnyProcurementGrant(user)) return false;
      return canApproveProcurement(user, amountAed ?? Number.NaN);
    case "decide-supplier":
      return canDecideSuppliers(user);
    case "integration":
      // Linking the accounting system: ADMIN and SUPER_ADMIN, the same
      // population as the other cards on Settings, Integrations.
      return canManageAccountingIntegration(user);
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
