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
import type { ProcurementUserLike } from "@/lib/procurement-visibility";
import { denyNonProcurement, type ProcurementNeed } from "./procurement-roles";
import type { BudgetErrorCode } from "../services/budget-service";

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

export const HTTP_STATUS_FOR_BUDGET_ERROR: Record<BudgetErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  EVENT_CODE_REQUIRED: 409,
  BUDGET_EXISTS: 409,
  BUDGET_NOT_FOUND: 404,
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
  LINE_HAS_COMMITMENTS: 409,
  VARIANCE_NOTES_REQUIRED: 422,
  UNKNOWN: 500,
};

export function rejected(route: string, userId: string, r: { code: string; message: string; meta?: Record<string, unknown> }, statusFor: Record<string, number>): NextResponse {
  apiLogger.warn({ msg: `${route}:rejected`, code: r.code, userId });
  return NextResponse.json({ error: r.message, code: r.code, ...(r.meta ? { meta: r.meta } : {}) }, { status: statusFor[r.code] ?? 500 });
}

export async function readJson(req: Request): Promise<unknown> {
  return req.json().catch(() => null);
}
