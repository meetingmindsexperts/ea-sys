import { requireCrmWrite, runCrmCsvImport, crmCsvImportBaseSchema } from "@/crm/lib/crm-route";
import { importFreshsalesContacts } from "@/crm/services/crm-import-service";

/**
 * POST /api/crm/import/contacts — Freshsales Contacts CSV → CrmContact
 * (companies named in the CSV are created if absent, so import order is not
 * brittle).
 *
 * Rate-limit / parse / error mapping live in runCrmCsvImport (one scaffold for
 * all three importers); the gate stays here so the gate-drift test sees it.
 */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;

  return runCrmCsvImport(req, ctx, {
    route: "crm/import/contacts:POST",
    schema: crmCsvImportBaseSchema,
    importer: (_data, base) => importFreshsalesContacts(base),
  });
}
