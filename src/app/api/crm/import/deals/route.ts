import { z } from "zod";
import { requireCrmWrite, runCrmCsvImport, crmCsvImportBaseSchema } from "@/crm/lib/crm-route";
import { importFreshsalesDeals } from "@/crm/services/crm-import-service";

const bodySchema = crmCsvImportBaseSchema.extend({
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
 * Rate-limit / parse / error mapping live in runCrmCsvImport (one scaffold for
 * all three importers); the gate stays here so the gate-drift test sees it.
 */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;

  return runCrmCsvImport(req, ctx, {
    route: "crm/import/deals:POST",
    schema: bodySchema,
    importer: (data, base) =>
      importFreshsalesDeals({
        ...base,
        fallbackEventId: data.fallbackEventId,
        defaultCurrency: data.defaultCurrency,
      }),
  });
}
