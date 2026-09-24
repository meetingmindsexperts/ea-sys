/**
 * The module's request shapes (Zod), shared by the routes and, later, the MCP
 * mirrors so the two cannot drift. Client-safe. Money arrives as a string or
 * number and is handed to the service as-is; the service converts through
 * `money()`, which is exact.
 */
import { z } from "zod";

export const BUDGET_CURRENCIES = ["AED", "USD", "EUR", "GBP", "SAR"] as const;
export const EVENT_BRANDS = ["MMG_EXPERTS", "MEDCOM", "MEDULIVE"] as const;
export const BENCHMARK_SOURCE_TYPES = ["EA_SYS_BUDGET", "ARCHIVE_SUMMARY", "NONE"] as const;

const moneyInput = z.union([z.number(), z.string().trim().min(1)]).refine(
  (v) => Number.isFinite(Number(v)) && Number(v) >= 0,
  { message: "Must be a non-negative amount" },
);
const rateInput = z.union([z.number(), z.string().trim().min(1)]).refine(
  (v) => Number.isFinite(Number(v)) && Number(v) > 0,
  { message: "Must be a rate greater than zero" },
);
const amountInput = z.union([z.number(), z.string().trim().min(1)]).refine(
  (v) => Number.isFinite(Number(v)) && Number(v) > 0,
  { message: "Must be an amount greater than zero" },
);
const dateInput = z.string().datetime().transform((s) => new Date(s));

export const createBudgetSchema = z.object({
  eventId: z.string().min(1).max(100),
  templateId: z.string().min(1).max(100).nullable().optional(),
  reportingCurrency: z.enum(BUDGET_CURRENCIES),
  contingencyPercent: moneyInput.optional(),
  brand: z.enum(EVENT_BRANDS).nullable().optional(),
  expectedAttendance: z.number().int().min(0).max(1_000_000).nullable().optional(),
  benchmarkSourceType: z.enum(BENCHMARK_SOURCE_TYPES).optional(),
  benchmarkSourceId: z.string().max(100).nullable().optional(),
  financeOwnerUserId: z.string().max(100).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

export const updateBudgetHeaderSchema = z.object({
  expectedVersion: z.number().int().min(0),
  contingencyPercent: moneyInput.optional(),
  reportingCurrency: z.enum(BUDGET_CURRENCIES).optional(),
  brand: z.enum(EVENT_BRANDS).nullable().optional(),
  expectedAttendance: z.number().int().min(0).max(1_000_000).nullable().optional(),
  benchmarkSourceType: z.enum(BENCHMARK_SOURCE_TYPES).optional(),
  benchmarkSourceId: z.string().max(100).nullable().optional(),
  naCategoryCodes: z.array(z.string().max(50)).max(200).optional(),
  financeOwnerUserId: z.string().max(100).nullable().optional(),
  freezeAt: dateInput.nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  /** Percent of revenue the author aims to keep; null clears it. */
  targetMarginPercent: moneyInput.nullable().optional(),
});

export const upsertRevenueLineSchema = z.object({
  categoryId: z.string().min(1).max(100).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  qty: moneyInput.optional(),
  unitAmount: moneyInput.optional(),
  transactionCurrency: z.enum(BUDGET_CURRENCIES).optional(),
  fxRateToReporting: moneyInput.nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});
export const createRevenueLineSchema = upsertRevenueLineSchema.extend({
  categoryId: z.string().min(1).max(100),
  description: z.string().trim().min(1).max(500),
});

export const upsertBudgetLineSchema = z.object({
  /** A catalogue item (BudgetProduct id); null unlinks. */
  productId: z.string().max(100).nullable().optional(),
  categoryId: z.string().min(1).max(100).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  qty: moneyInput.optional(),
  unitCost: moneyInput.optional(),
  transactionCurrency: z.string().trim().length(3).toUpperCase().optional(),
  fxRateToReporting: rateInput.nullable().optional(),
  taxCode: z.string().max(30).nullable().optional(),
  taxRatePercent: moneyInput.nullable().optional(),
  serviceStart: dateInput.nullable().optional(),
  serviceEnd: dateInput.nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  forecastFinalAmount: moneyInput.nullable().optional(),
  forecastReason: z.string().max(1000).nullable().optional(),
  varianceNote: z.string().max(2000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export const submitBudgetSchema = z.object({ reportingToAedRate: rateInput.nullable().optional() });
/**
 * A decision on any approval subject: a budget, a reallocation or a spend
 * request.
 *
 * A REJECTION MUST CARRY A REASON. Approving needs no words (the amount, the
 * line and the trail already say everything), but a refusal is the one
 * outcome whose "why" exists nowhere else: the requester has to act on it,
 * and months later it is the only record of why the money was not spent.
 * Supplier decisions have demanded this since they shipped; budgets, spend
 * requests and reallocations did not, which left the refusal that costs
 * somebody the most work as the only one that could be silent.
 */
export const decideSchema = z
  .object({ decision: z.enum(["APPROVED", "REJECTED"]), note: z.string().max(2000).nullable().optional() })
  .superRefine((v, ctx) => {
    if (v.decision === "REJECTED" && !v.note?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "Say why it is rejected; the person who raised it reads this." });
    }
  });
export const reallocateSchema = z.object({
  fromLineKey: z.string().min(1).max(100),
  toLineKey: z.string().min(1).max(100),
  amount: amountInput,
  reason: z.string().trim().min(1).max(1000),
  reportingToAedRate: rateInput.nullable().optional(),
});
export const transitionSchema = z.object({
  action: z.enum(["freeze", "unfreeze", "close", "sign-off", "reopen"]),
  reason: z.string().max(1000).optional(),
  varianceNotes: z.record(z.string().max(100), z.string().max(2000)).optional(),
  /** Reporting currency to AED, the one rate the module speaks; a peg is never taken from the caller. */
  reportingToAedRate: rateInput.nullable().optional(),
});

export const createCategorySchema = z.object({
  code: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(120),
  parentId: z.string().max(100).nullable().optional(),
  type: z.enum(["EXPENSE", "REVENUE"]).optional(),
});
export const createProductSchema = z.object({
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
  /** Optional when the SKU is an account number: the product then goes under its account group. */
  categoryId: z.string().min(1).max(100).nullable().optional(),
});
export const patchProductSchema = z
  .object({ name: z.string().trim().min(1).max(160).optional(), categoryId: z.string().min(1).max(100).optional(), isActive: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.categoryId !== undefined || v.isActive !== undefined, { message: "Nothing to change" });
export const patchCategorySchema = z.object({ isActive: z.boolean().optional(), name: z.string().trim().min(1).max(120).optional() }).refine((v) => v.isActive !== undefined || v.name !== undefined, { message: "Nothing to change" });

export const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  eventType: z.enum(["CONFERENCE", "WEBINAR", "HYBRID"]),
  description: z.string().max(2000).nullable().optional(),
});
export const patchTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  eventType: z.enum(["CONFERENCE", "WEBINAR", "HYBRID"]).optional(),
  description: z.string().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
});
export const upsertTemplateLineSchema = z.object({
  categoryId: z.string().min(1).max(100).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  defaultQty: moneyInput.nullable().optional(),
  defaultUnitCost: moneyInput.nullable().optional(),
  defaultCurrency: z.enum(BUDGET_CURRENCIES).nullable().optional(),
  taxCode: z.string().max(30).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

// ── Suppliers (Phase 2, slice 1) ─────────────────────────────────────────────
export const supplierContactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  role: z.string().trim().max(80).optional(),
});
/** Classified (spec §2.9): stored, shown to the settle holder and staff, never audited. */
export const supplierBankDetailsSchema = z.object({
  bankName: z.string().trim().max(120).optional(),
  accountName: z.string().trim().max(120).optional(),
  iban: z.string().trim().max(40).optional(),
  swift: z.string().trim().max(20).optional(),
  accountNumber: z.string().trim().max(40).optional(),
});
/**
 * The supplier's billing address, switchboard and accounts inbox (24 September
 * 2026). One shape, spread into both the create and the update schema so the
 * two cannot drift. Not classified: the address prints on the purchase order.
 * The address country is the supplier's existing `country`.
 *
 * An empty string clears a field (the dialogs send "" for a blanked box). The
 * accounts email is lower-cased at input, the house rule for addresses.
 */
export const supplierProfileShape = {
  billingLine1: z.string().trim().max(200).nullable().optional(),
  billingLine2: z.string().trim().max(200).nullable().optional(),
  billingCity: z.string().trim().max(100).nullable().optional(),
  billingRegion: z.string().trim().max(100).nullable().optional(),
  billingPostalCode: z.string().trim().max(20).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  accountsEmail: z.union([z.literal(""), z.string().trim().toLowerCase().email().max(200)]).nullable().optional(),
};
/** The field names of `supplierProfileShape`, for the service and the export. */
export const SUPPLIER_PROFILE_FIELDS = Object.keys(supplierProfileShape) as (keyof typeof supplierProfileShape)[];

export const proposeSupplierSchema = z.object({
  code: z.string().trim().min(1).max(20).optional(),
  legalName: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(120).optional(),
  taxRegistrationNo: z.string().trim().max(40).nullable().optional(),
  country: z.string().trim().max(80).nullable().optional(),
  ...supplierProfileShape,
  currency: z.string().trim().length(3).toUpperCase(),
  contacts: z.array(supplierContactSchema).max(10).optional(),
  paymentTerms: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export const updateSupplierSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    legalName: z.string().trim().min(1).max(200).optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    taxRegistrationNo: z.string().trim().max(40).nullable().optional(),
    country: z.string().trim().max(80).nullable().optional(),
    ...supplierProfileShape,
    currency: z.string().trim().length(3).toUpperCase().optional(),
    contacts: z.array(supplierContactSchema).max(10).optional(),
    paymentTerms: z.string().trim().max(120).nullable().optional(),
    bankDetails: supplierBankDetailsSchema.nullable().optional(),
    riskStatus: z.enum(["NONE", "WATCH", "BLOCKED"]).optional(),
    isActive: z.boolean().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "expectedVersion"), { message: "Nothing to change" });
export const decideSupplierSchema = z.object({ decision: z.enum(["APPROVED", "REJECTED"]), note: z.string().trim().max(2000).nullable().optional() });

/** A CSV import: the file travels as text in the JSON body (the middleware caps it at 1 MB, the parser at 5,000 rows). */
export const importCsvSchema = z.object({ csv: z.string().min(1).max(1_048_576) });

// ── spend requests (Phase 2 slice 2) ─────────────────────────────────────────
export const SPEND_REQUEST_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const SOURCING_METHODS = ["SINGLE_QUOTE", "COMPETITIVE_QUOTES", "EXISTING_CONTRACT", "SOLE_SOURCE"] as const;
const isoCurrency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "A currency is a three-letter code");
/** A request is priced in one of the module's five currencies, whatever the case it arrives in. */
const moduleCurrency = z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.enum(BUDGET_CURRENCIES));
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date is YYYY-MM-DD");

/** A VAT percentage: 0 to 100, two decimals, the same shape BudgetLine.taxRatePercent stores. */
const percentInput = z.union([z.number(), z.string().trim().min(1)]).refine(
  (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100,
  { message: "A VAT rate is a percentage between 0 and 100" },
);

const spendRequestFields = {
  budgetId: z.string().min(1).max(100),
  lineKey: z.string().min(1).max(100).nullable().optional(),
  title: z.string().trim().min(1).max(200),
  justification: z.string().trim().max(4000).nullable().optional(),
  amount: amountInput,
  /**
   * The VAT RATE. `taxAmount` is computed from it server-side and a rate sent
   * with an amount wins, so a client cannot state 5% and send a different
   * figure beside it. NULL is the deliberate escape hatch for a bill with no
   * single rate, and then `taxAmount` is taken as given.
   */
  taxRatePercent: percentInput.nullable().optional(),
  taxAmount: moneyInput.nullable().optional(),
  /** One of the module's currencies (spec §14 Q7): the pegs and the plausibility band exist only for them. */
  currency: moduleCurrency,
  /** Request currency to the budget's reporting currency; ignored for the same currency or two pegged ones, banded otherwise. */
  fxRateToReporting: rateInput.nullable().optional(),
  supplierId: z.string().min(1).max(100).nullable().optional(),
  proposedVendorName: z.string().trim().max(200).nullable().optional(),
  categoryId: z.string().min(1).max(100).nullable().optional(),
  neededBy: calendarDay.nullable().optional(),
  sourcingMethod: z.enum(SOURCING_METHODS).nullable().optional(),
  priority: z.enum(SPEND_REQUEST_PRIORITIES).optional(),
  /** Email the purchase order PDF to the supplier when the order is issued (default off; the Send button is the manual path). */
  emailSupplierOnIssue: z.boolean().optional(),
};
export const createSpendRequestSchema = z.object(spendRequestFields);
export const updateSpendRequestSchema = z.object({ ...spendRequestFields, expectedVersion: z.number().int().min(1) }).partial({ budgetId: true, title: true, amount: true, currency: true });
export const submitSpendRequestSchema = z.object({
  /** Reporting currency to AED for the ceiling; a peg is never taken from the caller. */
  reportingToAedRate: rateInput.nullable().optional(),
  expectedVersion: z.number().int().min(1),
});
export const spendRequestTransitionSchema = z.object({
  action: z.enum(["withdraw", "cancel"]),
  reason: z.string().trim().max(2000).nullable().optional(),
  expectedVersion: z.number().int().min(1),
});
export const amendSpendRequestSchema = z.object({
  amount: amountInput,
  /** Omitted, the request's own rate re-applies to the new amount; sent, it replaces it. */
  taxRatePercent: percentInput.nullable().optional(),
  taxAmount: moneyInput.nullable().optional(),
  reason: z.string().trim().min(1).max(2000),
  reportingToAedRate: rateInput.nullable().optional(),
  expectedVersion: z.number().int().min(1),
});
export const createQuoteSchema = z.object({
  vendorName: z.string().trim().min(1).max(200),
  supplierId: z.string().min(1).max(100).nullable().optional(),
  amount: amountInput,
  taxAmount: moneyInput.nullable().optional(),
  currency: isoCurrency,
  quotedOn: calendarDay.nullable().optional(),
  validUntil: calendarDay.nullable().optional(),
  recommended: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
// ── purchase orders (slice 3) ────────────────────────────────────────────────
export const receiveOrderSchema = z.object({
  extent: z.enum(["PARTIAL", "FULL"]),
  expectedVersion: z.number().int().min(1),
});
export const confirmReceiptSchema = z.object({ expectedVersion: z.number().int().min(1) });
export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  expectedVersion: z.number().int().min(1),
});

/** The live side panel's question: this amount on this line, what does the check say and who would decide? */
export const budgetCheckQuerySchema = z.object({
  budgetId: z.string().min(1).max(100),
  lineKey: z.string().min(1).max(100),
  amount: amountInput,
  currency: moduleCurrency,
  fxRateToReporting: rateInput.nullable().optional(),
  reportingToAedRate: rateInput.nullable().optional(),
  /** Leave this request out of the "already asked for" figure when it is being edited. */
  excludeRequestId: z.string().min(1).max(100).nullable().optional(),
});
