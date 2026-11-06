/**
 * THE CRM'S DOCUMENT PORTS (Nov 6, 2026; CRM product review P1-8): rendering a
 * quote PDF, and the issuing organisation's branding printed on it.
 *
 * The quote service asks these two questions and nothing else: it no longer
 * reaches the core PDF layout helpers or reads logos off disk itself. The
 * defaults are EA-SYS's: the quote layout in src/crm/lib/quote-pdf.ts (built
 * on core's shared PDF primitives) and the organisation's own company fields
 * and logo. A standalone CRM supplies its own.
 */
import { loadLocalLogo, toAddressLines } from "@/lib/pdf/document-layout";
import { renderQuotePdf, type QuotePdfInput } from "@/crm/lib/quote-pdf";

export interface CrmQuoteRenderer {
  renderQuote(input: QuotePdfInput): Promise<Buffer>;
}

/** The organisation fields a quote's letterhead is made from. */
export interface IssuerSource {
  name: string;
  companyName: string | null;
  logo: string | null;
  companyAddress: string | null;
  companyCity: string | null;
  companyState: string | null;
  companyZipCode: string | null;
  companyCountry: string | null;
  taxId: string | null;
}

export type QuoteIssuer = QuotePdfInput["company"];

export interface CrmOrganizationBranding {
  /** The name printed on the quote: the company name, else the organisation's. */
  issuerName(org: Pick<IssuerSource, "name" | "companyName">): string;
  /** The full letterhead, logo loaded. */
  issuer(org: IssuerSource): Promise<QuoteIssuer>;
}

export const crmQuoteRenderer: CrmQuoteRenderer = { renderQuote: renderQuotePdf };

export const crmBranding: CrmOrganizationBranding = {
  issuerName: (org) => org.companyName || org.name,
  async issuer(org) {
    return {
      name: org.companyName || org.name,
      addressLines: toAddressLines(
        org.companyAddress,
        [org.companyCity, org.companyState, org.companyZipCode].filter(Boolean).join(" "),
        org.companyCountry,
      ),
      taxId: org.taxId,
      logoBuffer: await loadLocalLogo(org.logo),
    };
  },
};
