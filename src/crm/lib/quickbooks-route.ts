/**
 * The CRM's QuickBooks lookup routes (Nov 4, 2026): their gate and the mapping
 * of a failed QuickBooks read to an error value. Server only.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import type { OrgContext } from "@/lib/api-auth";
import { requireCrmRead, crmCan } from "@/crm/lib/crm-route";

const LOOKUP_LIMIT = 600;
const LOOKUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Who may search QuickBooks to link: CRM write permission, but NOT the shared
 * CRM write bucket. Each picker keystroke is a lookup, and linking a catalogue
 * of a hundred products would spend the whole organisation's hourly write
 * budget, leaving every rep's ordinary saves at 429 (review of 1ad88f53).
 * Lookups get their own per-person bucket instead.
 */
export async function requireQboLookup(
  req: Request,
  route: string,
): Promise<{ error: NextResponse; ctx?: never } | { error?: never; ctx: OrgContext }> {
  const read = await requireCrmRead(req);
  if (read.error) return read;
  const { ctx } = read;
  if (!crmCan(ctx, "crm.write")) {
    apiLogger.warn({ msg: "crm/quickbooks:lookup-forbidden", route, role: ctx.role, userId: ctx.userId, organizationId: ctx.organizationId });
    return { error: NextResponse.json({ error: "You cannot link records to QuickBooks", code: "FORBIDDEN" }, { status: 403 }) };
  }
  const who = ctx.userId ?? `org:${ctx.organizationId}`;
  const limit = checkRateLimit({ key: `crm-qbo-lookup:${who}`, limit: LOOKUP_LIMIT, windowMs: LOOKUP_WINDOW_MS });
  if (!limit.allowed) {
    return {
      error: rateLimited(limit, { route, limit: LOOKUP_LIMIT, windowSeconds: LOOKUP_WINDOW_MS / 1000, organizationId: ctx.organizationId }),
    };
  }
  return { ctx };
}

const NOT_CONNECTED = new Set(["NOT_CONFIGURED", "NOT_CONNECTED", "ENVIRONMENT_MISMATCH", "APP_CHANGED", "REFRESH_EXPIRED"]);

export function qboLookupFail(res: { code: string; message: string }, organizationId: string, lookup: string) {
  apiLogger.warn({ msg: "crm/quickbooks:lookup-failed", organizationId, lookup, qboCode: res.code, message: res.message });
  return NOT_CONNECTED.has(res.code)
    ? { code: "QBO_NOT_CONNECTED", message: "QuickBooks is not connected. An admin connects it in Settings → Integrations." }
    : { code: "QBO_ERROR", message: `QuickBooks did not answer: ${res.message}` };
}
