/**
 * CRM quote rules: the pure, client-safe half of the quote editor
 * (Sep 15, 2026, owner request with a Freshsales quote as the sample).
 *
 * Owner decisions this module encodes:
 *  - A quote is SAVED and edited in place: same number, re-rendered PDF.
 *  - The currency is picked per quote. There is no conversion: a line's unit
 *    price is typed in the quote's currency, and a catalogue price pre-fills a
 *    line only when the product is already priced in that currency.
 *  - Terms come from an org default (Organization.settings.crmQuote.terms),
 *    seeded with the sample's paragraph, editable per quote.
 *  - Numbers are yearly: Q-2026-0003, a sequence per organisation per year.
 *
 * Money is computed ONCE here and stored frozen on the quote, so the editor's
 * live preview, the saved row and the PDF cannot disagree.
 *
 * No Node imports: the editor dialog imports this file.
 */
import { z } from "zod";

export const QUOTE_CURRENCIES = ["USD", "AED", "SAR", "EUR", "GBP"] as const;
export type QuoteCurrency = (typeof QUOTE_CURRENCIES)[number];

export function isQuoteCurrency(value: string | null | undefined): value is QuoteCurrency {
  return !!value && (QUOTE_CURRENCIES as readonly string[]).includes(value);
}

/** Quote dates and the numbering year are read in the company's timezone. */
export const QUOTE_TIMEZONE = "Asia/Dubai";
export const DEFAULT_QUOTE_VALIDITY_DAYS = 30;
export const MAX_QUOTE_LINES = 100;
/** The largest value a Decimal(12,2) column holds. */
export const MAX_QUOTE_AMOUNT = 9_999_999_999.99;

/**
 * The sample quote's terms, with its two typos corrected ("We this is the case"
 * and "terms and contacts"). Only the seed: each org edits its own default.
 */
export const DEFAULT_QUOTE_TERMS =
  "This quotation is subject to 5% VAT. Please read the terms and conditions carefully. " +
  "This forms the contract between the customer and our company and, in the event of a " +
  "conflict, these terms and conditions shall prevail. We will provide the services " +
  "described in the quote/estimate as presented. As an assignment develops, the scope of " +
  "the required work may change. Where this is the case, we will seek to discuss it with " +
  "you at the earliest opportunity in order to agree upon any variations to the scope of " +
  "the services and the quote/estimate.";

export const QUOTE_DIGITAL_NOTE =
  "This is a digitally generated quote/estimate and therefore no signature is required.";

// ── Dates (calendar strings, never Date objects in the rules) ────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD. Rejects 2026-02-31, which Date.UTC rolls over. */
export function isValidDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Today in the quote timezone as YYYY-MM-DD. */
export function todayInQuoteTimezone(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: QUOTE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDaysToDateString(value: string, days: number): string {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The numbering year: the calendar year in the quote timezone when the number is minted. */
export function quoteYear(now: Date = new Date()): number {
  return Number(todayInQuoteTimezone(now).slice(0, 4));
}

/** Day-first, zero-padded, the house format on invoices and receipts: 15/09/2026. */
export function formatQuoteDate(value: string): string {
  if (!isValidDateString(value)) return value;
  const [y, m, d] = value.split("-");
  return `${d}/${m}/${y}`;
}

export function formatQuoteNumber(year: number, sequence: number): string {
  return `Q-${year}-${String(sequence).padStart(4, "0")}`;
}

// ── Money ─────────────────────────────────────────────────────────────────────

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function formatQuoteMoney(amount: number, currency: string): string {
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `${formatted} ${currency}`;
}

/** "5" for 5, "5.5" for 5.5: a rate prints without trailing zeros. */
export function formatTaxRate(rate: number): string {
  return String(Number(rate.toFixed(2)));
}

export interface QuoteTotals {
  /** Per line, in input order: quantity × unit price, rounded to cents. */
  amounts: number[];
  subtotal: number;
  /** null when no tax applies (absent, zero or negative input). */
  taxRate: number | null;
  taxAmount: number;
  total: number;
}

/**
 * Tax is charged on the subtotal, not per line, and every figure is rounded to
 * cents at the step that produces it, so the stored total always equals the
 * sum of the stored parts.
 */
export function computeQuoteTotals(
  lines: ReadonlyArray<{ quantity: number; unitPrice: number }>,
  taxRate: number | null | undefined,
): QuoteTotals {
  const amounts = lines.map((l) => round2(l.quantity * l.unitPrice));
  const subtotal = round2(amounts.reduce((sum, a) => sum + a, 0));
  const rate = typeof taxRate === "number" && taxRate > 0 ? taxRate : null;
  const taxAmount = rate ? round2((subtotal * rate) / 100) : 0;
  return { amounts, subtotal, taxRate: rate, taxAmount, total: round2(subtotal + taxAmount) };
}

// ── Org defaults ──────────────────────────────────────────────────────────────

/**
 * Reads Organization.settings.crmQuote defensively.
 *
 * `configured` is true once an admin has saved default terms, INCLUDING saving
 * them empty, which means "no default terms" (owner decision, Sep 15 2026).
 * A missing block, a missing key or a corrupt value is unconfigured, and the
 * caller falls back to the built-in wording.
 */
export function readCrmQuoteDefaults(settings: unknown): { configured: boolean; terms: string | null } {
  const unconfigured = { configured: false, terms: null };
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return unconfigured;
  const block = (settings as Record<string, unknown>).crmQuote;
  if (!block || typeof block !== "object" || Array.isArray(block)) return unconfigured;
  const terms = (block as Record<string, unknown>).terms;
  if (terms !== null && typeof terms !== "string") return unconfigured;
  return { configured: true, terms: typeof terms === "string" && terms.trim() ? terms : null };
}

// ── Input schemas (shared by the routes and the dialog) ──────────────────────

const dateString = z.string().refine(isValidDateString, "Use a valid date (YYYY-MM-DD)");

export const quoteLineInputSchema = z.object({
  productCode: z.string().trim().max(60).nullable().optional(),
  name: z.string().trim().min(1, "Every line needs a product name").max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  quantity: z.number().int("Quantity must be a whole number").min(1).max(100000),
  unitPrice: z.number().min(0).max(MAX_QUOTE_AMOUNT),
  crmProductId: z.string().max(40).nullable().optional(),
});

/** The object without the cross-field rule, so a route can take `.partial()` of it. */
export const quoteInputObject = z.object({
  title: z.string().trim().min(1, "Give the quote a title").max(200),
  currency: z.enum(QUOTE_CURRENCIES),
  quoteDate: dateString,
  validUntil: dateString,
  preparedFor: z.string().trim().min(1, "Say who the quote is prepared for").max(200),
  attention: z.string().trim().max(200).nullable().optional(),
  taxRate: z.number().min(0).max(100).nullable().optional(),
  taxLabel: z.string().trim().max(30).optional(),
  terms: z.string().max(10000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  lines: z.array(quoteLineInputSchema).min(1, "Add at least one line").max(MAX_QUOTE_LINES),
});

export const quoteInputSchema = quoteInputObject.refine((v) => v.validUntil >= v.quoteDate, {
  message: "Valid until must be on or after the quote date",
  path: ["validUntil"],
});

export type QuoteInput = z.infer<typeof quoteInputObject>;
export type QuoteLineInput = z.infer<typeof quoteLineInputSchema>;

// ── Shapes returned by the API ────────────────────────────────────────────────

export interface CrmQuoteLineRow {
  id: string;
  productCode: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unitPrice: number;
  amount: number;
  crmProductId: string | null;
}

export interface CrmQuoteRow {
  id: string;
  number: string;
  title: string;
  currency: string;
  quoteDate: string;
  validUntil: string;
  preparedFor: string;
  attention: string | null;
  preparedByName: string;
  taxRate: number | null;
  taxLabel: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  terms: string | null;
  notes: string | null;
  version: number;
  documentId: string | null;
  createdAt: string;
  updatedAt: string;
  lines: CrmQuoteLineRow[];
}

export interface CrmQuoteDraftLine {
  productCode: string | null;
  name: string;
  description: string | null;
  quantity: number;
  /** Pre-filled only when the product is priced in the draft's currency. */
  unitPrice: number | null;
  /** The catalogue currency of the product, so the editor can flag a mismatch. */
  productCurrency: string | null;
  /**
   * The catalogue unit price in `productCurrency`, whatever the draft's currency,
   * so the editor can fill it when the rep switches the quote to that currency.
   * Never converted. Null for a line with no catalogue product.
   */
  cataloguePrice: number | null;
  crmProductId: string | null;
}

export interface CrmQuoteDraft {
  title: string;
  currency: QuoteCurrency;
  quoteDate: string;
  validUntil: string;
  preparedFor: string;
  attention: string | null;
  preparedByName: string;
  taxRate: number | null;
  taxLabel: string;
  terms: string | null;
  notes: string | null;
  eventName: string | null;
  /** The deal's product lines, offered as the starting lines. */
  lines: CrmQuoteDraftLine[];
}
