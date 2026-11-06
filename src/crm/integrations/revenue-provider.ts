/**
 * The CRM's side of the revenue contract (src/lib/contracts/crm-revenue.ts):
 * the won deals of one event, as plain values. The only place outside the CRM's
 * own screens that reads deal money for another module, so the deal model can
 * change behind it.
 */
import { db } from "@/lib/db";
import { orgHasModule } from "@/lib/module-entitlements";
import type { CrmRevenueProvider, CrmWonDeal } from "@/lib/contracts/crm-revenue";

export const crmRevenueProvider: CrmRevenueProvider = {
  async wonDealsForEvent({ organizationId, eventId }): Promise<CrmWonDeal[]> {
    // An organisation without the CRM has no deal revenue to show (review of 1d2261da).
    if (!(await orgHasModule(organizationId, "crm"))) return [];
    const deals = await db.crmDeal.findMany({
      where: { organizationId, eventId, status: "WON", archivedAt: null },
      select: {
        dealValue: true,
        currency: true,
        products: { select: { productName: true, category: true, unitPrice: true, quantity: true, currency: true, crmProduct: { select: { source: true, category: true } } } },
      },
    });
    return deals.map((d) => ({
      dealValue: d.dealValue === null ? null : d.dealValue.toString(),
      currency: d.currency,
      products: d.products.map((p) => ({
        productName: p.productName,
        // The live catalogue product decides the account; a deleted one falls back to the line's snapshot and has no source.
        category: p.crmProduct?.category ?? p.category,
        source: p.crmProduct?.source ?? null,
        quantity: p.quantity,
        unitPrice: p.unitPrice.toString(),
        currency: p.currency,
      })),
    }));
  },
};
