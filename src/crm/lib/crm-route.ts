/**
 * Shared route boundary for /api/crm/*.
 *
 * Auth, money-redaction and error→HTTP mapping live HERE rather than being
 * re-typed in every handler. Nine routes each hand-rolling their own guard is
 * how one of them ends up missing it — which is precisely the shape of the
 * contacts H1 bug (the guard sat on the writes; the reads had none).
 *
 * The services never import next/server; the mapping from a service's error CODE
 * to an HTTP status is a boundary concern and lives here.
 */
import { NextResponse } from "next/server";
import { getOrgContext, type OrgContext } from "@/lib/api-auth";
import { redactFinancialFields } from "@/lib/finance-visibility";
import { canViewDealValues, denyCrmAccess, denyCrmWrite } from "@/crm/lib/crm-visibility";

/**
 * Resolve the caller and enforce the CRM read gate in one step.
 *
 * Returns either a ready-to-send error response, or the org context. Every
 * /api/crm/* handler starts with this — including the READS. (The read gate is
 * not optional: ONSITE, REVIEWER, SUBMITTER and REGISTRANT are all org-adjacent
 * enough to reach these routes, and none of them may see the sponsorship board.)
 */
export async function requireCrmRead(
  req: Request,
): Promise<{ error: NextResponse; ctx?: never } | { error?: never; ctx: OrgContext }> {
  const ctx = await getOrgContext(req);
  if (!ctx) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const denied = denyCrmAccess(ctx); // logs its own refusal
  if (denied) return { error: denied };
  return { ctx };
}

/** As above, plus the write gate (blocks MEMBER — it reads the board, never moves a card). */
export async function requireCrmWrite(
  req: Request,
): Promise<{ error: NextResponse; ctx?: never } | { error?: never; ctx: OrgContext }> {
  const read = await requireCrmRead(req);
  if (read.error) return read;
  const denied = denyCrmWrite(read.ctx); // logs its own refusal
  if (denied) return { error: denied };
  return { ctx: read.ctx };
}

/**
 * Strip deal money for callers who may not see it (MEMBER).
 *
 * `dealValue` is in FINANCIAL_KEYS, so the existing recursive redactor does the
 * work — this just decides WHETHER to run it, using the CRM's own predicate
 * (narrower than canViewFinance(), which would let a sponsor-side MEMBER read
 * every rival's deal value).
 */
export function redactForCaller<T>(payload: T, ctx: OrgContext): T {
  if (canViewDealValues(ctx.role, ctx.fromApiKey)) return payload;
  return redactFinancialFields(payload);
}

/**
 * Service error code → HTTP status.
 *
 * Anything unmapped falls to 400 rather than 500: an unrecognised *business*
 * rejection is a client problem, and defaulting to 500 would page us for it.
 */
const STATUS_BY_CODE: Record<string, number> = {
  // not found
  DEAL_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  COMPANY_NOT_FOUND: 404,
  CONTACT_NOT_FOUND: 404,
  EVENT_NOT_FOUND: 404,
  OWNER_NOT_FOUND: 404,
  STAGE_NOT_FOUND: 404,
  // conflict — someone else got there first, or the state moved under us
  STAGE_CHANGED: 409,
  ALREADY_CLOSED: 409,
  ALREADY_DONE: 409,
  STAGE_HAS_DEALS: 409,
  // bad request
  NAME_REQUIRED: 400,
  TITLE_REQUIRED: 400,
  NO_FIELDS: 400,
  // ours
  UNKNOWN: 500,
};

export function crmErrorResponse(fail: {
  code: string;
  message: string;
  meta?: Record<string, unknown>;
}): NextResponse {
  const status = STATUS_BY_CODE[fail.code] ?? 400;
  return NextResponse.json(
    { error: fail.message, code: fail.code, ...(fail.meta ? { meta: fail.meta } : {}) },
    { status },
  );
}
