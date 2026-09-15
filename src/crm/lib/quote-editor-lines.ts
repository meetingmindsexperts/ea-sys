/**
 * Editor lines for the CRM quote dialog (client-safe, pure).
 *
 * Prices are never converted between currencies. What this module guards is the
 * quieter failure: a price entered while the quote was in one currency staying
 * on the line after the currency changes, so 95,000 typed as USD prints as
 * 95,000.00 AED with nothing on screen saying so. Every line therefore remembers
 * the currency its price was entered in, and a switch treats the two kinds of
 * price differently:
 *
 * - an untouched catalogue price is re-derived for the new currency (re-filled
 *   when the product is priced in it, cleared otherwise), because it was never
 *   the user's number;
 * - a typed or saved price is kept, because it is the user's number, and flagged
 *   until they re-enter it or confirm it stands in the new currency.
 */
import type { CrmQuoteDraftLine, CrmQuoteRow } from "@/crm/lib/quote-rules";

export interface EditorLine {
  key: string;
  productCode: string;
  name: string;
  description: string;
  quantity: string;
  unitPrice: string;
  crmProductId: string | null;
  /**
   * The catalogue product behind the line, kept so a currency switch can re-fill
   * or clear its price: `price` is the catalogue price in `currency`, never
   * converted. Null for typed and saved lines.
   */
  catalogue: { price: number | null; currency: string } | null;
  /** The currency `unitPrice` was entered in; null while the price is empty. */
  priceCurrency: string | null;
  /** True while the price is the untouched catalogue price. */
  priceFromCatalogue: boolean;
}

function newKey(): string {
  return globalThis.crypto.randomUUID();
}

export function blankLine(): EditorLine {
  return {
    key: newKey(),
    productCode: "",
    name: "",
    description: "",
    quantity: "1",
    unitPrice: "",
    crmProductId: null,
    catalogue: null,
    priceCurrency: null,
    priceFromCatalogue: false,
  };
}

/** Take the catalogue price for `currency` when there is one, else empty the price. */
function catalogueFill(line: EditorLine, currency: string): EditorLine {
  if (line.catalogue && line.catalogue.price !== null && line.catalogue.currency === currency) {
    return { ...line, unitPrice: String(line.catalogue.price), priceCurrency: currency, priceFromCatalogue: true };
  }
  return { ...line, unitPrice: "", priceCurrency: null, priceFromCatalogue: false };
}

export function fromDraftLine(line: CrmQuoteDraftLine, currency: string): EditorLine {
  const base: EditorLine = {
    key: newKey(),
    productCode: line.productCode ?? "",
    name: line.name,
    description: line.description ?? "",
    quantity: String(line.quantity),
    unitPrice: "",
    crmProductId: line.crmProductId,
    // The catalogue price in the product's own currency; filled only when the quote is in it.
    catalogue: line.productCurrency
      ? { price: line.cataloguePrice ?? line.unitPrice, currency: line.productCurrency }
      : null,
    priceCurrency: null,
    priceFromCatalogue: false,
  };
  return catalogueFill(base, currency);
}

export function fromQuoteLine(line: CrmQuoteRow["lines"][number], quoteCurrency: string): EditorLine {
  return {
    key: newKey(),
    productCode: line.productCode ?? "",
    name: line.name,
    description: line.description ?? "",
    quantity: String(line.quantity),
    unitPrice: String(line.unitPrice),
    crmProductId: line.crmProductId,
    catalogue: null,
    priceCurrency: quoteCurrency,
    priceFromCatalogue: false,
  };
}

/** The user typed into the price box: it is now their number, in the current currency. */
export function withTypedPrice(line: EditorLine, value: string, currency: string): EditorLine {
  return { ...line, unitPrice: value, priceCurrency: value.trim() ? currency : null, priceFromCatalogue: false };
}

export function switchLinesCurrency(lines: EditorLine[], next: string): EditorLine[] {
  return lines.map((l) => (l.priceFromCatalogue || !l.unitPrice.trim() ? catalogueFill(l, next) : l));
}

/** Lines holding a price that was entered while the quote was in another currency. */
export function linesPricedInOtherCurrency(lines: EditorLine[], currency: string): EditorLine[] {
  return lines.filter((l) => l.unitPrice.trim() !== "" && l.priceCurrency !== null && l.priceCurrency !== currency);
}

/** The user confirmed the flagged prices stand as they are in `currency`. */
export function keepPricesIn(lines: EditorLine[], currency: string): EditorLine[] {
  return lines.map((l) =>
    l.unitPrice.trim() !== "" && l.priceCurrency !== currency
      ? { ...l, priceCurrency: currency, priceFromCatalogue: false }
      : l,
  );
}

/** Empty lines whose catalogue price is in another currency, so the user must type one. */
export function linesNeedingPrice(lines: EditorLine[], currency: string): EditorLine[] {
  return lines.filter((l) => !l.unitPrice.trim() && l.catalogue !== null && l.catalogue.currency !== currency);
}
