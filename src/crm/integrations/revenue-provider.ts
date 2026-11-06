/**
 * The CRM's side of the revenue contract (src/lib/contracts/crm-revenue.ts):
 * the won deals of one event, as plain values. The only place outside the CRM's
 * own screens that reads deal money for another module, so the deal model can
 * change behind it.
 */
import { db } from "@/lib/db";
import { orgModuleState } from "@/lib/module-entitlements";
import type { CrmRevenueProvider, CrmWonDeal, CrmWonDealProduct } from "@/lib/contracts/crm-revenue";

/** The contract's source, mapped explicitly so a new enum value cannot slip through unconverted. */
function productSource(source: string | null | undefined): CrmWonDealProduct["source"] {
  if (source === "IN_HOUSE" || source === "OUTSOURCED") return source;
  return null;
}

export const crmRevenueProvider: CrmRevenueProvider = {
  async wonDealsForEvent({ organizationId, eventId }): Promise<CrmWonDeal[]> {
    // An organisation without the CRM has no deal revenue to show (review of
    // 1d2261da). "Could not tell" is NOT "off": a budget close-out keeps the
    // figures it reads, so a database blip must fail the read, never record
    // zero sponsorship revenue for good (review of 7dd4e9e5, MED).
    const state = await orgModuleState(organizationId, "crm");
    if (state === "unknown") throw new Error(`CRM entitlement unknown for ${organizationId}; revenue not read`);
    if (state === "off") return [];
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
        source: productSource(p.crmProduct?.source),
        quantity: p.quantity,
        unitPrice: p.unitPrice.toString(),
        currency: p.currency,
      })),
    }));
  },
};
