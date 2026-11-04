/**
 * CRM quote → QuickBooks Estimate rules (Nov 4, 2026). Pure and client-safe,
 * so the deal screen and the send service judge readiness the same way.
 *
 * Owner decisions this encodes:
 *  - a quote goes to QuickBooks as an ESTIMATE, one line per product, and only
 *    once its deal is won; QuickBooks issues the invoice;
 *  - EA-SYS links a sponsor to an EXISTING QuickBooks customer, never creates
 *    one;
 *  - every line must come from a catalogue product linked to a QuickBooks
 *    product/service; a hand-typed line refuses the send.
 *
 * A link counts only for the QuickBooks company (realm) it was made in, so a
 * link made against the sandbox never posts to the real books.
 */

/** Organization.settings.crmQuickBooks: the tax codes a quote's VAT maps to. */
export interface CrmQuickBooksSettings {
  realmId: string;
  /** The code for a quote with VAT (its rate must equal the quote's). */
  vatTaxCodeId: string;
  vatTaxCodeName: string;
  vatRate: number;
  /** The code for a quote with no VAT. */
  noVatTaxCodeId: string;
  noVatTaxCodeName: string;
}

export function readCrmQuickBooksSettings(settings: unknown): CrmQuickBooksSettings | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const block = (settings as Record<string, unknown>).crmQuickBooks;
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const b = block as Record<string, unknown>;
  const text = (k: string) => (typeof b[k] === "string" && (b[k] as string).length > 0 ? (b[k] as string) : null);
  const realmId = text("realmId");
  const vatTaxCodeId = text("vatTaxCodeId");
  const noVatTaxCodeId = text("noVatTaxCodeId");
  const vatRate = typeof b.vatRate === "number" && Number.isFinite(b.vatRate) ? b.vatRate : null;
  if (!realmId || !vatTaxCodeId || !noVatTaxCodeId || vatRate === null) return null;
  return {
    realmId,
    vatTaxCodeId,
    vatTaxCodeName: text("vatTaxCodeName") ?? vatTaxCodeId,
    vatRate,
    noVatTaxCodeId,
    noVatTaxCodeName: text("noVatTaxCodeName") ?? noVatTaxCodeId,
  };
}

export type QuickBooksProblem =
  | { code: "DEAL_NOT_WON"; message: string }
  | { code: "CUSTOMER_NOT_LINKED"; message: string }
  | { code: "CURRENCY_MISMATCH"; message: string }
  | { code: "TAX_CODES_NOT_SET"; message: string }
  | { code: "TAX_RATE_MISMATCH"; message: string }
  | { code: "NOTES_TOO_LONG"; message: string }
  | { code: "LINE_NOT_FROM_CATALOGUE"; message: string; line: number }
  | { code: "PRODUCT_NOT_LINKED"; message: string; line: number; crmProductId: string };

export interface ReadinessInput {
  realmId: string;
  dealStatus: string;
  company: {
    name: string;
    qboCustomerId: string | null;
    qboCustomerCurrency: string | null;
    qboRealmId: string | null;
  } | null;
  quote: { currency: string; taxRate: number | null; notes?: string | null };
  lines: Array<{
    name: string;
    crmProductId: string | null;
    product: { name: string; qboItemId: string | null; qboRealmId: string | null } | null;
  }>;
  settings: CrmQuickBooksSettings | null;
}

export interface ReadyPlan {
  customerId: string;
  taxCodeId: string;
  /** The QuickBooks product/service per line, in line order. */
  itemIds: string[];
}

/** Rates are percentages with at most two decimals; compare them as such. */
function sameRate(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

/**
 * Everything that stops this quote going to QuickBooks, all at once, or the
 * ids it maps to. Listing every problem lets the rep fix them in one pass
 * instead of discovering them one send at a time.
 */
export function quickBooksReadiness(input: ReadinessInput): { ok: true; plan: ReadyPlan } | { ok: false; problems: QuickBooksProblem[] } {
  const problems: QuickBooksProblem[] = [];
  const linkedHere = (realm: string | null) => realm === input.realmId;

  if (input.dealStatus !== "WON") {
    problems.push({ code: "DEAL_NOT_WON", message: "Mark the deal won before sending its quote to QuickBooks." });
  }

  const company = input.company;
  const customerId = company && company.qboCustomerId && linkedHere(company.qboRealmId) ? company.qboCustomerId : null;
  if (!company) {
    problems.push({ code: "CUSTOMER_NOT_LINKED", message: "Add the sponsor company to the deal, then link it to its QuickBooks customer." });
  } else if (!customerId) {
    problems.push({ code: "CUSTOMER_NOT_LINKED", message: `Link ${company.name} to its QuickBooks customer.` });
  } else if (company.qboCustomerCurrency && company.qboCustomerCurrency !== input.quote.currency) {
    problems.push({
      code: "CURRENCY_MISMATCH",
      message: `The quote is in ${input.quote.currency} but ${company.name}'s QuickBooks customer is in ${company.qboCustomerCurrency}. Link the ${input.quote.currency} customer, or change the quote's currency.`,
    });
  }

  const settings = input.settings && linkedHere(input.settings.realmId) ? input.settings : null;
  let taxCodeId: string | null = null;
  if (!settings) {
    problems.push({ code: "TAX_CODES_NOT_SET", message: "An admin has to choose the QuickBooks VAT codes in CRM settings first." });
  } else if (input.quote.taxRate && input.quote.taxRate > 0) {
    if (sameRate(input.quote.taxRate, settings.vatRate)) taxCodeId = settings.vatTaxCodeId;
    else {
      problems.push({
        code: "TAX_RATE_MISMATCH",
        message: `The quote charges ${input.quote.taxRate}% VAT, but the QuickBooks VAT code ${settings.vatTaxCodeName} is ${settings.vatRate}%.`,
      });
    }
  } else {
    taxCodeId = settings.noVatTaxCodeId;
  }

  if ((input.quote.notes?.length ?? 0) > NOTES_MAX) {
    problems.push({
      code: "NOTES_TOO_LONG",
      message: `QuickBooks prints at most ${NOTES_MAX.toLocaleString("en")} characters of notes on an Estimate. Shorten the quote's notes.`,
    });
  }

  const itemIds: string[] = [];
  input.lines.forEach((l, i) => {
    const line = i + 1;
    if (!l.crmProductId || !l.product) {
      problems.push({
        code: "LINE_NOT_FROM_CATALOGUE",
        line,
        message: `Line ${line} (${l.name}) was typed by hand. Replace it with a catalogue product.`,
      });
      return;
    }
    if (!l.product.qboItemId || !linkedHere(l.product.qboRealmId)) {
      problems.push({
        code: "PRODUCT_NOT_LINKED",
        line,
        crmProductId: l.crmProductId,
        message: `Line ${line}: link the product ${l.product.name} to its QuickBooks product/service.`,
      });
      return;
    }
    itemIds.push(l.product.qboItemId);
  });

  if (problems.length > 0 || !customerId || !taxCodeId) return { ok: false, problems };
  return { ok: true, plan: { customerId, taxCodeId, itemIds } };
}

/** The marker an Estimate carries so a later send can recognise it as this quote's. */
export function estimateMarker(quoteId: string): string {
  return `EA-SYS quote ${quoteId}`;
}

/** QuickBooks' limit on the message an Estimate prints (its CustomerMemo). */
export const NOTES_MAX = 1000;

/**
 * How far QuickBooks' total may sit from the quote's before it is flagged. The
 * quote taxes its subtotal; QuickBooks may round the tax line by line, so each
 * line can move the total by up to half a cent.
 */
export function totalTolerance(lineCount: number): number {
  return 0.05 + 0.005 * lineCount;
}

/** A send that holds its claim longer than this was left by a process that died. */
export const QBO_SEND_STALE_MS = 2 * 60 * 1000;

/**
 * QuickBooks' requestid for a quote's send. The same while `attempt` holds, so
 * a retry after a lost answer returns the first result; `attempt` moves on
 * after a definite refusal, so a fixed quote is not answered with the old no.
 */
export function estimateRequestId(quoteId: string, attempt: number): string {
  return `crmq-${quoteId}-${attempt}`.slice(0, 50);
}
