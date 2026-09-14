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
});

export const upsertBudgetLineSchema = z.object({
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
export const decideSchema = z.object({ decision: z.enum(["APPROVED", "REJECTED"]), note: z.string().max(2000).nullable().optional() });
export const reallocateSchema = z.object({
  fromLineKey: z.string().min(1).max(100),
  toLineKey: z.string().min(1).max(100),
  amount: rateInput,
  reason: z.string().trim().min(1).max(1000),
  reportingToAedRate: rateInput.nullable().optional(),
});
export const transitionSchema = z.object({
  action: z.enum(["freeze", "unfreeze", "close", "sign-off", "reopen"]),
  reason: z.string().max(1000).optional(),
  varianceNotes: z.record(z.string().max(100), z.string().max(2000)).optional(),
  aedToReportingRate: rateInput.nullable().optional(),
});

export const createCategorySchema = z.object({
  code: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(120),
  parentId: z.string().max(100).nullable().optional(),
  type: z.enum(["EXPENSE", "REVENUE"]).optional(),
});
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
