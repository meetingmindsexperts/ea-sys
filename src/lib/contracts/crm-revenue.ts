/**
 * THE CRM REVENUE CONTRACT (Nov 6, 2026; CRM product review P1-7).
 *
 * Budgets reads the money won on an event's sponsorship deals. It used to read
 * `db.crmDeal` itself, so Procurement depended on the CRM's TABLES: any change
 * to the deal model, and any day the CRM lives in its own database, broke the
 * budget. Now the CRM answers through this interface and Procurement never
 * names a CRM model.
 *
 * WHERE THE PIECES LIVE. The interface is here, in core, because both modules
 * may import core and neither may import the other. The CRM implements it in
 * src/crm/integrations/revenue-provider.ts. src/lib/module-wiring.ts (the one
 * named ESLint exemption for it) hands that implementation to whoever asks. An
 * in-process call today; if the CRM is ever deployed apart, only the wiring
 * changes, to a client for the same interface.
 *
 * Plain values only (strings for money): no Prisma types cross the boundary.
 */

export interface CrmWonDealProduct {
  productName: string;
  /** The live catalogue product's category, else the line's snapshot. */
  category: string | null;
  /** The live catalogue product's source; null when the product was deleted. */
  source: "IN_HOUSE" | "OUTSOURCED" | null;
  quantity: number;
  /** Decimal as a string. */
  unitPrice: string;
  currency: string;
}

export interface CrmWonDeal {
  /** Decimal as a string; null when the deal carries no value. */
  dealValue: string | null;
  currency: string;
  products: CrmWonDealProduct[];
}

export interface CrmRevenueProvider {
  /**
   * The WON, live (not archived) deals that count under one event of one
   * organisation: the event's own, and those of a corporate project linked
   * to it (the CRM decides which, in src/crm/lib/deal-attribution.ts). Independent of the CRM entitlement: a suspended CRM's won
   * deals are still revenue (empty for an organisation that never had deals).
   */
  wonDealsForEvent(input: { organizationId: string; eventId: string }): Promise<CrmWonDeal[]>;
}
