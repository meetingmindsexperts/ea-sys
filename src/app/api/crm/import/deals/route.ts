import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { importFreshsalesDeals } from "@/crm/services/crm-import-service";

const bodySchema = z.object({
  csv: z.string().min(1).max(15_000_000),
  dryRun: z.boolean().optional(),
  /** Deals whose name matches no event land here — a deal must have an event. */
  fallbackEventId: z.string().min(1),
  /** Used when the CSV carries no currency column. */
  defaultCurrency: z.string().length(3).optional(),
});

/**
 * POST /api/crm/import/deals — Freshsales Deals CSV → CrmDeal.
 *
 * The Id column is required (the upsert key that makes re-imports converge).
 * Won/Lost import with their historical close dates; stage names map onto the
 * org's pipeline, unmatched → the first open stage — all reported in the
 * dry-run the dialog shows before anything writes.
 */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;

  const limit = checkRateLimit({
    key: `crm-import:org:${ctx.organizationId}`,
    limit: 20,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.allowed) {
    apiLogger.warn({ msg: "crm/import:rate-limited", organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: "Too many imports — try again shortly", code: "RATE_LIMITED", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/import/deals:POST", organizationId: ctx.organizationId });
  }

  const result = await importFreshsalesDeals({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    csvText: parsed.data.csv,
    dryRun: parsed.data.dryRun ?? false,
    fallbackEventId: parsed.data.fallbackEventId,
    defaultCurrency: parsed.data.defaultCurrency,
  });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json(result);
}
