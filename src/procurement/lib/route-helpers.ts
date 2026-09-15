/**
 * What every procurement route does before its own work, in one place:
 * authenticate, refuse on the flag or the grant (logged, with the route
 * named), resolve the organisation, and rate-limit writes. Then the route
 * maps a service result onto an HTTP status through one table.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { rateLimited } from "@/lib/api-errors";
import { requireOrgId } from "@/lib/require-org";
import { checkRateLimit } from "@/lib/security";
import { canAdminProcurement, canApproveProcurement, canRequestProcurement, canSettleProcurement, type ProcurementUserLike } from "@/lib/procurement-visibility";
import { denyNonProcurement, type ProcurementNeed } from "./procurement-roles";
import type { BudgetErrorCode } from "../services/budget-service";
import type { SpendRequestErrorCode } from "../services/spend-request-service";
import type { CommitmentErrorCode, OrderActor } from "../services/commitment-service";

export type ProcurementActor = ProcurementUserLike & { id: string; organizationId: string };

export type GuardResult =
  | { ok: true; orgId: string; user: ProcurementActor }
  | { ok: false; response: NextResponse };

export async function procurementGuard(opts: { route: string; need: ProcurementNeed; amountAed?: number; write?: boolean }): Promise<GuardResult> {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: `${opts.route}:unauthorized` });
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const denied = denyNonProcurement(session, { route: opts.route, need: opts.need, amountAed: opts.amountAed });
  if (denied) return { ok: false, response: denied };
  const org = requireOrgId(session, { route: opts.route });
  if ("error" in org) return { ok: false, response: org.error };
  if (opts.write) {
    const rl = checkRateLimit({ key: `procurement-write:${session.user.id}`, limit: 300, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) return { ok: false, response: rateLimited(rl, { route: opts.route, userId: session.user.id, limit: 300, windowSeconds: 3600 }) };
  }
  return {
    ok: true,
    orgId: org.orgId,
    user: {
      id: session.user.id,
      organizationId: org.orgId,
      role: session.user.role ?? null,
      procurementRequest: session.user.procurementRequest ?? false,
      procurementApproveCeilingAed: session.user.procurementApproveCeilingAed ?? null,
      procurementApproveUnlimited: session.user.procurementApproveUnlimited ?? false,
      procurementSettle: session.user.procurementSettle ?? false,
    },
  };
}

/**
 * A draft spend request is edited by its requester or by a module admin
 * (who may lack the request grant): the guard takes "view", and this refuses
 * everyone else with the same logged 403 the guard would write.
 */
export function denyUnlessRequestOrAdmin(route: string, user: ProcurementActor): NextResponse | null {
  if (canRequestProcurement(user) || canAdminProcurement(user)) return null;
  apiLogger.warn({ msg: `${route}:procurement-forbidden`, need: "request-or-admin", role: user.role ?? null, userId: user.id });
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

/**
 * Who is acting on a purchase order, as the commitment service judges it: the
 * guard admits "view" and the service decides per action (the requester with
 * the grant, the settle holder, an approver, an admin).
 */
export function orderActorFrom(user: ProcurementActor): OrderActor {
  return {
    id: user.id,
    isAdmin: canAdminProcurement(user),
    canRequest: canRequestProcurement(user),
    canSettle: canSettleProcurement(user),
    canApprove: canApproveProcurement(user, 0),
  };
}

export const HTTP_STATUS_FOR_COMMITMENT_ERROR: Record<CommitmentErrorCode, number> = {
  COMMITMENT_NOT_FOUND: 404,
  REQUEST_NOT_FOUND: 404,
  LINE_NOT_FOUND: 404,
  INVALID_STATUS: 409,
  ALREADY_ORDERED: 409,
  SUPPLIER_NOT_APPROVED: 409,
  BUDGET_NOT_ACTIVE: 409,
  BUDGET_CLOSED: 409,
  NOT_ALLOWED: 403,
  REASON_REQUIRED: 422,
  NO_SUPPLIER_EMAIL: 422,
  SEND_FAILED: 502,
  STALE_WRITE: 409,
  INVALID_FILTER: 400,
  UNKNOWN: 500,
};

export const HTTP_STATUS_FOR_BUDGET_ERROR: Record<BudgetErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  EVENT_CODE_REQUIRED: 409,
  BUDGET_EXISTS: 409,
  BUDGET_NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  TEMPLATE_NOT_FOUND: 404,
  CATEGORY_NOT_FOUND: 404,
  LINE_NOT_FOUND: 404,
  INVALID_STATUS: 409,
  STALE_WRITE: 409,
  CURRENCY_LOCKED: 409,
  RATE_REQUIRED: 400,
  INVALID_AMOUNT: 400,
  INCOMPLETE: 422,
  NO_APPROVER: 409,
  APPROVAL_FAILED: 409,
  VERSION_IN_PROGRESS: 409,
  CAP_EXCEEDED: 409,
  INVALID_FILTER: 400,
  LINE_HAS_COMMITMENTS: 409,
  VARIANCE_NOTES_REQUIRED: 422,
  UNKNOWN: 500,
};

export const HTTP_STATUS_FOR_SPEND_REQUEST_ERROR: Record<SpendRequestErrorCode, number> = {
  REQUEST_NOT_FOUND: 404,
  BUDGET_NOT_FOUND: 404,
  LINE_NOT_FOUND: 404,
  SUPPLIER_NOT_FOUND: 404,
  QUOTE_NOT_FOUND: 404,
  BUDGET_NOT_ACTIVE: 409,
  INVALID_STATUS: 409,
  NOT_REQUESTER: 403,
  FINAL_APPROVER_CANNOT_REQUEST: 403,
  STALE_WRITE: 409,
  RATE_REQUIRED: 400,
  INVALID_AMOUNT: 400,
  INCOMPLETE: 422,
  REASON_REQUIRED: 422,
  NO_APPROVER: 409,
  APPROVAL_FAILED: 409,
  INVALID_FILTER: 400,
  UNKNOWN: 500,
};

/**
 * A read that fails (a pooler blip, a bad row) is a logged 500, never a bare
 * one: the module's GETs have no rejection path of their own to log through.
 */
export async function guardedRead(route: string, userId: string, fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    apiLogger.error({ msg: `${route}:read-failed`, err, userId });
    return NextResponse.json({ error: "Could not load." }, { status: 500 });
  }
}

export function rejected(route: string, userId: string, r: { code: string; message: string; meta?: Record<string, unknown> }, statusFor: Record<string, number>): NextResponse {
  apiLogger.warn({ msg: `${route}:rejected`, code: r.code, userId });
  return NextResponse.json({ error: r.message, code: r.code, ...(r.meta ? { meta: r.meta } : {}) }, { status: statusFor[r.code] ?? 500 });
}

export async function readJson(req: Request): Promise<unknown> {
  return req.json().catch(() => null);
}
