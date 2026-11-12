/**
 * The CRM's side of the revenue contract (src/lib/contracts/crm-revenue.ts):
 * the won deals of one event, as plain values. The only place outside the CRM's
 * own screens that reads deal money for another module, so the deal model can
 * change behind it.
 *
 * NOT GATED BY THE CRM ENTITLEMENT (owner, Nov 6, 2026: "budgets can be
 * independent"). The entitlement decides who may USE the CRM; it never decides
 * what the books say. A won deal is revenue the organisation earned, switching
 * the CRM off suspends and deletes nothing, and a budget close-out keeps what
 * it reads, so gating this read would misstate a closed budget for good. An
 * organisation that never had the CRM has no deals, so the read is empty.
 */
import { db } from "@/lib/db";
import type { CrmRevenueProvider, CrmWonDeal, CrmWonDealProduct } from "@/lib/contracts/crm-revenue";
import { dealsOfEventWhere } from "@/crm/lib/deal-attribution";

/** The contract's source, mapped explicitly so a new enum value cannot slip through unconverted. */
function productSource(source: string | null | undefined): CrmWonDealProduct["source"] {
  if (source === "IN_HOUSE" || source === "OUTSOURCED") return source;
  return null;
}

export const crmRevenueProvider: CrmRevenueProvider = {
  async wonDealsForEvent({ organizationId, eventId }): Promise<CrmWonDeal[]> {
    const deals = await db.crmDeal.findMany({
      // The event's own deals and those of a corporate project linked to it:
      // one rule for which deals count under an event (deal-attribution.ts).
      where: { organizationId, ...dealsOfEventWhere(eventId), status: "WON", archivedAt: null },
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
