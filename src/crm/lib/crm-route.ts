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
import { canViewDealValues, denyCrmAccess, denyCrmWrite, denyCrmDelete } from "@/crm/lib/crm-visibility";

// Re-exported so route handlers have one import site (the PATCH restore branch
// calls this inline after requireCrmWrite).
export { denyCrmDelete } from "@/crm/lib/crm-visibility";

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
 * As requireCrmWrite, plus the ARCHIVE/RESTORE gate (blocks ORGANIZER, who may edit
 * but not archive). Used by the DELETE handlers. The restore branch of a PATCH,
 * which has already run requireCrmWrite, calls `denyCrmDelete(ctx)` inline instead.
 */
export async function requireCrmDelete(
  req: Request,
): Promise<{ error: NextResponse; ctx?: never } | { error?: never; ctx: OrgContext }> {
  const write = await requireCrmWrite(req);
  if (write.error) return write;

  const denied = denyCrmDelete(write.ctx); // logs its own refusal
  if (denied) return { error: denied };

  return { ctx: write.ctx };
}

/**
 * Free-text keys that routinely CONTAIN deal money ("Abbott came back at AED
 * 480k…"). Key-based redaction protects fields, not facts — stripping dealValue
 * while returning the negotiation prose hands a money-blind MEMBER the same
 * number through the side door (CRM review M2). So the prose channels are
 * stripped alongside the financial keys.
 */
const PROSE_KEYS = new Set(["notes", "crmNotes"]);

function stripProseKeys<T>(payload: T): T {
  if (Array.isArray(payload)) return payload.map((item) => stripProseKeys(item)) as T;
  if (payload === null || typeof payload !== "object" || payload instanceof Date) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (PROSE_KEYS.has(k)) continue;
    out[k] = stripProseKeys(v);
  }
  return out as T;
}

/**
 * Strip deal money for callers who may not see it (MEMBER).
 *
 * `dealValue` is in FINANCIAL_KEYS, so the existing recursive redactor does the
 * work — this just decides WHETHER to run it, using the CRM's own predicate
 * (narrower than canViewFinance(), which would let a sponsor-side MEMBER read
 * every rival's deal value). Prose fields (notes) are stripped too — see
 * PROSE_KEYS above.
 */
export function redactForCaller<T>(payload: T, ctx: OrgContext): T {
  if (canViewDealValues(ctx.role, ctx.fromApiKey)) return payload;
  return stripProseKeys(redactFinancialFields(payload));
}

/**
 * The note/activity-log READ gate (CRM review M2, owner-ratified option (a)):
 * the negotiation log is money-adjacent, so reading it requires the same
 * predicate as seeing deal values. Returns a 403 for MEMBER, null otherwise.
 * Logs its own refusal, like every CRM guard.
 */
export function denyCrmProseRead(ctx: OrgContext) {
  if (canViewDealValues(ctx.role, ctx.fromApiKey)) return null;
  apiLogger.warn({
    msg: "auth-guard:crm-notes-read-denied",
    role: ctx.role,
    userId: ctx.userId,
  });
  return NextResponse.json(
    { error: "Notes are not available to your role", code: "CRM_NOTES_FORBIDDEN" },
    { status: 403 },
  );
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
  TEMPLATE_NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  LINE_NOT_FOUND: 404,
  // forbidden — you may be in the CRM, but this row isn't yours to rewrite
  NOT_AUTHOR: 403,
  // conflict — someone else got there first, or the state moved under us
  STAGE_CHANGED: 409,
  ALREADY_CLOSED: 409,
  ALREADY_DONE: 409,
  STAGE_HAS_DEALS: 409,
  CONTACT_ALREADY_ON_DEAL: 409,
  PRODUCT_ALREADY_ON_DEAL: 409,
  // archived records are frozen — restore before mutating (CRM review M1)
  DEAL_ARCHIVED: 409,
  TASK_ARCHIVED: 409,
  // a business conflict, not a server fault (CRM review H4 — these used to fall
  // through as UNKNOWN → an unlogged 500 on an ordinary rename collision)
  NAME_TAKEN: 409,
  EMAIL_TAKEN: 409,
  // pipeline shape guards (CRM review H3)
  NO_TERMINAL_STAGE: 409,
  LAST_TERMINAL_STAGE: 409,
  // bad request
  NAME_REQUIRED: 400,
  EVENT_REQUIRED: 400,
  SUBJECT_REQUIRED: 400,
  CATEGORY_REQUIRED: 400,
  TITLE_REQUIRED: 400,
  BODY_REQUIRED: 400,
  EMAIL_REQUIRED: 400,
  NO_ATTACHMENT: 400,
  ATTACHMENT_TYPE_NOT_ALLOWED: 400,
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
  // Log at the choke point (CRM review M5): every service rejection flows through
  // here, so a service that forgets its own warn line still leaves a trace —
  // per-site logging is a discipline, boundary logging is a guarantee. Real
  // faults (UNKNOWN → 500) log at error; business rejections at warn.
  apiLogger[status >= 500 ? "error" : "warn"]({
    msg: "crm:business-rejection",
    code: fail.code,
    status,
    message: fail.message,
    ...(fail.meta ? { meta: fail.meta } : {}),
  });
  return NextResponse.json(
    { error: fail.message, code: fail.code, ...(fail.meta ? { meta: fail.meta } : {}) },
    { status },
  );
}
