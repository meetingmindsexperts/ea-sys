/**
 * Editor lines for the CRM quote dialog (client-safe, pure).
 *
 * Prices are never converted between currencies, and switching the quote's
 * currency changes no price. What this module guards is the quieter failure: a
 * price entered while the quote was in one currency staying on the line after
 * the currency changes, so 95,000 typed as USD prints as 95,000.00 AED with
 * nothing on screen saying so. Every line therefore remembers
 * the currency its price was entered in, and a line whose currency is not the
 * quote's is flagged until the rep deals with it:
 *
 * - an untouched catalogue price always fills, in the PRODUCT's currency
 *   (Nov 3, 2026, owner: "add the prices that exist but still edit"), so on a
 *   quote in another currency it arrives flagged exactly like a typed price in
 *   the wrong currency, and the save refuses it until the rep re-enters it or
 *   keeps it;
 * - a typed or saved price keeps the currency it was entered in, and is flagged
 *   the same way after a switch.
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
   * The catalogue price behind the line, in the product's own `currency`, never
   * converted. Null for typed and saved lines and for an unpriced product.
   */
  catalogue: { price: number | null; currency: string } | null;
  /** The currency `unitPrice` was entered in; null while the price is empty. */
  priceCurrency: string | null;
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
  };
}

/**
 * Take the catalogue price, labelled with the product's own currency, else empty
 * the price. A label that differs from the quote's is what flags the line.
 */
function catalogueFill(line: EditorLine): EditorLine {
  if (line.catalogue && line.catalogue.price !== null) {
    const { price, currency } = line.catalogue;
    return { ...line, unitPrice: String(price), priceCurrency: currency };
  }
  return { ...line, unitPrice: "", priceCurrency: null };
}

export function fromDraftLine(line: CrmQuoteDraftLine): EditorLine {
  const base: EditorLine = {
    key: newKey(),
    productCode: line.productCode ?? "",
    name: line.name,
    description: line.description ?? "",
    quantity: String(line.quantity),
    unitPrice: "",
    crmProductId: line.crmProductId,
    // The catalogue price in the product's own currency, flagged when the quote is in another.
    catalogue: line.productCurrency
      ? { price: line.cataloguePrice ?? line.unitPrice, currency: line.productCurrency }
      : null,
    priceCurrency: null,
  };
  return catalogueFill(base);
}

/**
 * A line picked straight from the catalogue in the editor, so a quote is not
 * limited to the products already on the deal. Linked to the product like a
 * deal line; its price fills in the product's own currency, flagged when the
 * quote is in another (no conversion). A price redacted for the viewer leaves
 * it to type.
 */
export function fromCatalogueProduct(product: {
  id: string;
  name: string;
  sku?: string | null;
  price?: string | number | null;
  currency: string;
}): EditorLine {
  // 0 is the column default, i.e. nobody priced it: as "0" it would save as a
  // free line, the rule buildQuoteDraft already applies to deal lines.
  const price = product.price == null || Number(product.price) === 0 ? null : Number(product.price);
  const base: EditorLine = {
    ...blankLine(),
    productCode: product.sku ?? "",
    name: product.name,
    crmProductId: product.id,
    catalogue: price !== null && Number.isFinite(price) ? { price, currency: product.currency } : null,
  };
  return catalogueFill(base);
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
  };
}

/** The user typed into the price box: it is now their number, in the current currency. */
export function withTypedPrice(line: EditorLine, value: string, currency: string): EditorLine {
  return { ...line, unitPrice: value, priceCurrency: value.trim() ? currency : null };
}

/** Lines holding a price that was entered while the quote was in another currency. */
export function linesPricedInOtherCurrency(lines: EditorLine[], currency: string): EditorLine[] {
  return lines.filter((l) => l.unitPrice.trim() !== "" && l.priceCurrency !== null && l.priceCurrency !== currency);
}

/** The user confirmed the flagged prices stand as they are in `currency`. */
export function keepPricesIn(lines: EditorLine[], currency: string): EditorLine[] {
  return lines.map((l) =>
    l.unitPrice.trim() !== "" && l.priceCurrency !== currency
      ? { ...l, priceCurrency: currency }
      : l,
  );
}

/**
 * Empty product lines the user must price: the product has no price the viewer
 * can see. A hand-added blank line is left to the save check.
 */
export function linesNeedingPrice(lines: EditorLine[]): EditorLine[] {
  return lines.filter((l) => !l.unitPrice.trim() && (l.crmProductId !== null || l.catalogue !== null));
}
