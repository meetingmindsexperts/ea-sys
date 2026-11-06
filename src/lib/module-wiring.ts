/**
 * MODULE WIRING: where one module's implementation of a core contract is handed
 * to another module (Nov 6, 2026; CRM product review P1-7).
 *
 * The only core file allowed to import src/crm/ for this purpose, by name, in
 * eslint.config.mjs. Everything it exports is typed by a contract in
 * src/lib/contracts/, so a consumer (Procurement) depends on the INTERFACE and
 * never sees a CRM type or table. Keep it to wiring: no logic lives here.
 */
import type { CrmRevenueProvider } from "@/lib/contracts/crm-revenue";
import { crmRevenueProvider as crmRevenue } from "@/crm/integrations/revenue-provider";

export function crmRevenueProvider(): CrmRevenueProvider {
  return crmRevenue;
}
