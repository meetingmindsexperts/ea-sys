import { requireCrmWrite, runCrmCsvImport, crmCsvImportBaseSchema } from "@/crm/lib/crm-route";
import { runWithTenant } from "@/lib/tenant-context";
import { importFreshsalesCompanies } from "@/crm/services/crm-import-service";

/**
 * POST /api/crm/import/companies — Freshsales Accounts CSV → CrmCompany.
 *
 * Write-gated + the shared tight import bucket (an import mints rows that are
 * awkward to clean up). Always run with dryRun:true first — the dialog does.
 * Rate-limit / parse / error mapping live in runCrmCsvImport (one scaffold for
 * all three importers); the gate stays here so the gate-drift test sees it.
 */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  return runCrmCsvImport(req, ctx, {
    auditEntityType: "CrmCompany",
    route: "crm/import/companies:POST",
    schema: crmCsvImportBaseSchema,
    importer: (_data, base) => importFreshsalesCompanies(base),
  });
  });
}
