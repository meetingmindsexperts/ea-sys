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
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
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

/**
 * As above, plus the write gate (blocks MEMBER — it reads the board, never moves
 * a card) AND a default per-org write rate limit.
 *
 * The rate limit lives HERE, not in each handler, deliberately. §7.4 says "rate
 * limits on writes", and the way that requirement is normally met — paste
 * `checkRateLimit` into each route — guarantees that the ninth route added six
 * months from now won't have one. Folding it into the gate every write route
 * already calls makes an unprotected CRM write structurally impossible.
 *
 * This is a BACKSTOP, generous by design (a busy sales day is a lot of clicks).
 * Expensive or abusable endpoints layer a tighter, named bucket on top — e.g.
 * company/deal creation is 100/hr, because those mint rows that are awkward to
 * clean up.
 */
const CRM_WRITE_LIMIT = 600;
const CRM_WRITE_WINDOW_MS = 60 * 60 * 1000;

export async function requireCrmWrite(
  req: Request,
): Promise<{ error: NextResponse; ctx?: never } | { error?: never; ctx: OrgContext }> {
  const read = await requireCrmRead(req);
  if (read.error) return read;

  const denied = denyCrmWrite(read.ctx); // logs its own refusal
  if (denied) return { error: denied };

  const limit = checkRateLimit({
    key: `crm-write:org:${read.ctx.organizationId}`,
    limit: CRM_WRITE_LIMIT,
    windowMs: CRM_WRITE_WINDOW_MS,
  });
  if (!limit.allowed) {
    apiLogger.warn({
      msg: "crm:write-rate-limited",
      organizationId: read.ctx.organizationId,
      userId: read.ctx.userId,
    });
    return {
      error: NextResponse.json(
        {
          error: "Too many changes — try again shortly",
          code: "RATE_LIMITED",
          retryAfterSeconds: limit.retryAfterSeconds,
          limit: CRM_WRITE_LIMIT,
          windowSeconds: CRM_WRITE_WINDOW_MS / 1000,
        },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      ),
    };
  }

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
  NOTE_NOT_FOUND: 404,
  EVENT_CONTACT_NOT_FOUND: 404,
  // forbidden — you may be in the CRM, but this row isn't yours to rewrite
  NOT_AUTHOR: 403,
  // conflict — someone else got there first, or the state moved under us
  STAGE_CHANGED: 409,
  ALREADY_CLOSED: 409,
  ALREADY_DONE: 409,
  STAGE_HAS_DEALS: 409,
  CONTACT_ALREADY_ON_DEAL: 409,
  // bad request
  NAME_REQUIRED: 400,
  TITLE_REQUIRED: 400,
  BODY_REQUIRED: 400,
  EMAIL_REQUIRED: 400,
  NO_ATTACHMENT: 400,
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
