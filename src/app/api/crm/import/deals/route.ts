import { z } from "zod";
import { runWithTenant } from "@/lib/tenant-context";
import { requireCrmWrite, runCrmCsvImport, crmCsvImportBaseSchema } from "@/crm/lib/crm-route";
import { importFreshsalesDeals } from "@/crm/services/crm-import-service";
import { CSV_DATE_FORMATS, DEFAULT_CSV_DATE_FORMAT } from "@/crm/lib/freshsales-import";

const bodySchema = crmCsvImportBaseSchema.extend({
  /** Deals whose name matches no event land here — a deal must have an event. */
  fallbackEventId: z.string().min(1),
  /** Used when the CSV carries no currency column. */
  defaultCurrency: z.string().length(3).optional(),
  /**
   * How to read `05/03/2026`. Declared, never guessed — see CSV_DATE_FORMATS.
   * Defaults to ISO (the one unambiguous shape) so an old client that doesn't
   * send the field can't silently opt into a day/month swap.
   */
  dateFormat: z.enum(CSV_DATE_FORMATS).default(DEFAULT_CSV_DATE_FORMAT),
  /**
   * Applied to every row in the file. Not a CSV column: `CrmDealPipeline` is our
   * own two-value classification and a Freshsales pipeline NAME can't be mapped
   * onto it without a translation table, so the operator states it per import.
   */
  pipeline: z.enum(["CORPORATE", "CONFERENCE"]).optional(),
});

/**
 * POST /api/crm/import/deals — Freshsales Deals CSV → CrmDeal.
 *
 * The Id column is required (the upsert key that makes re-imports converge).
 * Won/Lost import with their historical close dates; stage names map onto the
 * org's pipeline, unmatched → the first open stage — all reported in the
 * dry-run the dialog shows before anything writes.
 * Rate-limit / parse / error mapping live in runCrmCsvImport (one scaffold for
 * all three importers); the gate stays here so the gate-drift test sees it.
 */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  return runCrmCsvImport(req, ctx, {
    auditEntityType: "CrmDeal",
    route: "crm/import/deals:POST",
    schema: bodySchema,
    importer: (data, base) =>
      importFreshsalesDeals({
        ...base,
        fallbackEventId: data.fallbackEventId,
        defaultCurrency: data.defaultCurrency,
        dateFormat: data.dateFormat,
        pipeline: data.pipeline,
      }),
  });
  });
}
