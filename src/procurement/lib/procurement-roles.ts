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
  canRequestProcurement,
  canSettleProcurement,
  canViewProcurement,
  type ProcurementUserLike,
} from "@/lib/procurement-visibility";

export type ProcurementNeed = "view" | "author" | "admin" | "request" | "settle" | "approve";

export type ProcurementSession =
  | { user?: (ProcurementUserLike & { id?: string; organizationId?: string | null }) | null }
  | null
  | undefined;

function allowed(user: ProcurementUserLike | null | undefined, need: ProcurementNeed, amountAed?: number): boolean {
  switch (need) {
    case "view":
      return canViewProcurement(user);
    case "author":
      return canAuthorBudgets(user);
    case "admin":
      return canAdminProcurement(user);
    case "request":
      return canRequestProcurement(user);
    case "settle":
      return canSettleProcurement(user);
    case "approve":
      return canApproveProcurement(user, amountAed ?? Number.NaN);
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
