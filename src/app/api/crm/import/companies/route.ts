import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { importFreshsalesCompanies } from "@/crm/services/crm-import-service";

const bodySchema = z.object({
  /** Raw CSV text (the dialog reads the picked file). Row cap enforced by the parser. */
  csv: z.string().min(1).max(15_000_000),
  /** true → full decision run, zero writes — the report the operator confirms. */
  dryRun: z.boolean().optional(),
});

/**
 * POST /api/crm/import/companies — Freshsales Accounts CSV → CrmCompany.
 *
 * Write-gated + a tight named bucket (an import mints rows that are awkward to
 * clean up). Always run with dryRun:true first — the dialog does.
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
    return zodErrorResponse(parsed, { route: "crm/import/companies:POST", organizationId: ctx.organizationId });
  }

  const result = await importFreshsalesCompanies({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    csvText: parsed.data.csv,
    dryRun: parsed.data.dryRun ?? false,
  });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json(result);
}
