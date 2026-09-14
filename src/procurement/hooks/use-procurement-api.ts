"use client";

/**
 * React Query hooks for the Budget & Procurement module. Same shape as
 * src/hr/hooks/use-hr-api.ts, and for the same reason a separate file: the
 * import boundary is one-way and core must not reach in here.
 *
 * Every fetch goes through `get` or `send`, which throw core's `ApiError`
 * carrying the HTTP status; `QueryCache.onError` reads it to tell an expired
 * session from a fault. No `new Error(` in this file (pinned by
 * __tests__/lib/query-fetcher-status.test.ts).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BudgetActivityItem } from "@/procurement/lib/budget-activity";
import { ApiError, apiFetch } from "@/lib/api-fetch";

export type BudgetStatus = "DRAFT" | "UNDER_REVIEW" | "APPROVED" | "ACTIVE" | "FROZEN" | "CLOSED" | "ARCHIVED";
export const BUDGET_STATUS_ORDER: BudgetStatus[] = ["DRAFT", "UNDER_REVIEW", "APPROVED", "ACTIVE", "FROZEN", "CLOSED", "ARCHIVED"];
export const BUDGET_STATUS_LABEL: Record<BudgetStatus, string> = {
  DRAFT: "Draft",
  UNDER_REVIEW: "Under review",
  APPROVED: "Approved",
  ACTIVE: "Active",
  FROZEN: "Frozen",
  CLOSED: "Closed",
  ARCHIVED: "Archived",
};

export interface BudgetLineRow {
  id: string;
  lineKey: string;
  productId: string | null;
  product: { id: string; sku: string; name: string } | null;
  categoryId: string;
  category: { id: string; code: string; name: string; depth: number };
  description: string;
  qty: string;
  unitCost: string;
  transactionCurrency: string;
  fxRateToReporting: string;
  planned: string;
  committedOpen: string;
  committedTotal: string;
  actual: string;
  paid: string;
  taxRatePercent: string | null;
  taxAmountPlanned: string;
  approvedPlanned: string | null;
  reallocatedOut: string;
  forecastFinalAmount: string | null;
  forecastReason: string | null;
  varianceNote: string | null;
  notes: string | null;
  isContingency: boolean;
  sortOrder: number;
  /** planned minus committed-open minus actual (may be negative). */
  remaining: string;
  forecast: string;
}

export interface BudgetRow {
  id: string;
  eventId: string | null;
  eventCode: string;
  versionNo: number;
  status: BudgetStatus;
  reportingCurrency: string;
  brand: string | null;
  contingencyPercent: string;
  contingencyAmount: string;
  plannedExpenseTotal: string;
  taxTotalPlanned: string;
  forecastTotal: string;
  expectedAttendance: number | null;
  recordedAttendance: number | null;
  atRisk: boolean;
  naCategoryCodes: string[];
  submittedAt: string | null;
  approvedAt: string | null;
  activatedAt: string | null;
  frozenAt: string | null;
  closedAt: string | null;
  signedOffAt: string | null;
  closeOutSummary: unknown;
  notes: string | null;
  /** The optimistic-lock counter every header write must echo. */
  version: number;
  event: { id: string; name: string; slug: string; startDate: string; endDate: string; eventType: string } | null;
  lines?: BudgetLineRow[];
}

export interface ApprovalStepRow {
  id: string;
  sequence: number;
  assigneeUserId: string;
  assigneeName: string | null;
  delegateUserId: string | null;
  dueAt: string | null;
  status: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  note: string | null;
}

export interface ApprovalRequestRow {
  id: string;
  subjectType: "BUDGET" | "BUDGET_REALLOCATION";
  subjectId: string;
  amountAed: string;
  amount: string | null;
  currency: string | null;
  status: string;
  requesterUserId: string;
  requesterName: string | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  decidedAt: string | null;
  createdAt: string;
  budget: { id: string; eventCode: string; versionNo: number; status: BudgetStatus; reportingCurrency: string; event: { name: string } | null } | null;
  /** A reallocation's move with the two lines named, so the inbox reads without opening the budget. */
  move: { fromLineKey: string; toLineKey: string; amount: string; fromDescription: string | null; toDescription: string | null } | null;
  steps: ApprovalStepRow[];
}

export interface BudgetProductRow {
  id: string;
  sku: string;
  name: string;
  categoryId: string;
  isActive: boolean;
  sortOrder: number;
  category: { id: string; code: string; name: string };
}

export interface BudgetCategoryRow {
  id: string;
  code: string;
  name: string;
  type: "EXPENSE" | "REVENUE";
  parentId: string | null;
  depth: number;
  sortOrder: number;
  isActive: boolean;
}

export interface BudgetTemplateRow {
  id: string;
  name: string;
  eventType: string;
  lines: { id: string; categoryId: string; description: string; sortOrder: number; category: { id: string; code: string; name: string } }[];
}

const FORBIDDEN_MESSAGE =
  "You do not have access to Budget & Procurement. Org staff read it; authoring, approving and settling are granted per person under Settings, Users.";

export async function get<T>(url: string): Promise<T> {
  try {
    return await apiFetch<T>(url);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) throw new ApiError(FORBIDDEN_MESSAGE, err.status, err.data);
    throw err;
  }
}

export async function send<T>(url: string, method: string, body?: unknown, fallback?: string): Promise<T> {
  try {
    return await apiFetch<T>(url, {
      method,
      ...(body !== undefined && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch (err) {
    if (fallback && err instanceof ApiError && typeof err.data?.error !== "string") throw new ApiError(fallback, err.status, err.data);
    throw err;
  }
}

export const procurementKeys = {
  budgets: (eventId?: string, status?: string) => ["procurement", "budgets", eventId ?? "all", status ?? "all"] as const,
  budget: (budgetId: string) => ["procurement", "budget", budgetId] as const,
  /** Under the budget key on purpose: every budget mutation's invalidation refreshes the log too. */
  budgetActivity: (budgetId: string) => ["procurement", "budget", budgetId, "activity"] as const,
  approvals: (scope: "inbox" | "mine") => ["procurement", "approvals", scope] as const,
  categories: () => ["procurement", "categories"] as const,
  products: () => ["procurement", "products"] as const,
  templates: () => ["procurement", "templates"] as const,
};

export function useBudgets(filter: { eventId?: string; status?: string } = {}) {
  const qs = new URLSearchParams();
  if (filter.eventId) qs.set("eventId", filter.eventId);
  if (filter.status) qs.set("status", filter.status);
  const q = qs.toString();
  return useQuery({
    queryKey: procurementKeys.budgets(filter.eventId, filter.status),
    queryFn: () => get<{ budgets: BudgetRow[] }>(`/api/procurement/budgets${q ? `?${q}` : ""}`).then((r) => r.budgets),
  });
}

export function useBudget(budgetId: string | null) {
  return useQuery({
    queryKey: procurementKeys.budget(budgetId ?? "none"),
    queryFn: () => get<{ budget: BudgetRow }>(`/api/procurement/budgets/${budgetId}`).then((r) => r.budget),
    enabled: !!budgetId,
  });
}

export function useBudgetActivity(budgetId: string | null) {
  return useQuery({
    queryKey: procurementKeys.budgetActivity(budgetId ?? "none"),
    queryFn: () => get<{ items: BudgetActivityItem[]; truncated: boolean }>(`/api/procurement/budgets/${budgetId}/activity`),
    enabled: !!budgetId,
  });
}

export function useBudgetProducts() {
  return useQuery({
    queryKey: procurementKeys.products(),
    queryFn: () => get<{ products: BudgetProductRow[] }>("/api/procurement/products").then((r) => r.products),
  });
}

export function useCreateBudgetProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { sku: string; name: string; categoryId: string }) =>
      send<{ product: BudgetProductRow }>("/api/procurement/products", "POST", input, "Couldn't create the product").then((r) => r.product),
    onSuccess: () => void qc.invalidateQueries({ queryKey: procurementKeys.products() }),
  });
}

export function useUpdateBudgetProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, ...input }: { productId: string; name?: string; categoryId?: string; isActive?: boolean }) =>
      send<{ product: BudgetProductRow }>(`/api/procurement/products/${productId}`, "PATCH", input, "Couldn't save the product").then((r) => r.product),
    onSuccess: () => void qc.invalidateQueries({ queryKey: procurementKeys.products() }),
  });
}

export function useBudgetCategories() {
  return useQuery({
    queryKey: procurementKeys.categories(),
    queryFn: () => get<{ categories: BudgetCategoryRow[] }>("/api/procurement/categories").then((r) => r.categories),
    staleTime: 30 * 60 * 1000,
  });
}

export function useBudgetTemplates() {
  return useQuery({
    queryKey: procurementKeys.templates(),
    queryFn: () => get<{ templates: BudgetTemplateRow[] }>("/api/procurement/templates").then((r) => r.templates),
    staleTime: 30 * 60 * 1000,
  });
}

export function useApprovals(scope: "inbox" | "mine") {
  return useQuery({
    queryKey: procurementKeys.approvals(scope),
    queryFn: () => get<{ requests: ApprovalRequestRow[] }>(`/api/procurement/approvals?scope=${scope}`).then((r) => r.requests),
  });
}

/** Every budget mutation refreshes the list, the budget itself and both approval scopes. */
function useBudgetInvalidation() {
  const qc = useQueryClient();
  return (budgetId?: string) => {
    void qc.invalidateQueries({ queryKey: ["procurement", "budgets"] });
    void qc.invalidateQueries({ queryKey: ["procurement", "approvals"] });
    if (budgetId) void qc.invalidateQueries({ queryKey: procurementKeys.budget(budgetId) });
  };
}

export interface CreateBudgetInput {
  eventId: string;
  templateId?: string | null;
  reportingCurrency: string;
  contingencyPercent?: number;
  brand?: string | null;
  expectedAttendance?: number | null;
  notes?: string | null;
}

export function useCreateBudget() {
  const invalidate = useBudgetInvalidation();
  return useMutation({
    mutationFn: (input: CreateBudgetInput) => send<{ budget: BudgetRow }>("/api/procurement/budgets", "POST", input, "Couldn't create the budget").then((r) => r.budget),
    onSuccess: (b) => invalidate(b.id),
  });
}

export function useUpdateBudgetHeader(budgetId: string) {
  const invalidate = useBudgetInvalidation();
  return useMutation({
    mutationFn: (input: Record<string, unknown> & { expectedVersion: number }) =>
      send<{ budget: BudgetRow }>(`/api/procurement/budgets/${budgetId}`, "PATCH", input, "Couldn't save the budget").then((r) => r.budget),
    onSuccess: () => invalidate(budgetId),
  });
}

export function useUpsertBudgetLine(budgetId: string) {
  const invalidate = useBudgetInvalidation();
  return useMutation({
    mutationFn: ({ lineId, ...input }: Record<string, unknown> & { lineId?: string }) =>
      send<{ budget: BudgetRow }>(lineId ? `/api/procurement/budgets/${budgetId}/lines/${lineId}` : `/api/procurement/budgets/${budgetId}/lines`, lineId ? "PATCH" : "POST", input, "Couldn't save the line").then((r) => r.budget),
    onSuccess: () => invalidate(budgetId),
  });
}

export function useDeleteBudgetLine(budgetId: string) {
  const invalidate = useBudgetInvalidation();
  return useMutation({
    mutationFn: (lineId: string) => send<{ budget: BudgetRow }>(`/api/procurement/budgets/${budgetId}/lines/${lineId}`, "DELETE", undefined, "Couldn't remove the line").then((r) => r.budget),
    onSuccess: () => invalidate(budgetId),
  });
}

export function useSubmitBudget(budgetId: string) {
  const invalidate = useBudgetInvalidation();
  return useMutation({
    mutationFn: (input: { reportingToAedRate?: string | null } = {}) =>
      send<{ budget: BudgetRow }>(`/api/procurement/budgets/${budgetId}/submit`, "POST", input, "Couldn't submit the budget").then((r) => r.budget),
    onSuccess: () => invalidate(budgetId),
  });
}

export function useDecideBudget(budgetId: string) {
  const invalidate = useBudgetInvalidation();
  return useMutation({
    mutationFn: (input: { decision: "APPROVED" | "REJECTED"; note?: string | null }) =>
      send<{ budget: BudgetRow }>(`/api/procurement/budgets/${budgetId}/decide`, "POST", input, "Couldn't record the decision").then((r) => r.budget),
    onSuccess: () => invalidate(budgetId),
  });
}

export function useDecideApproval() {
  const invalidate = useBudgetInvalidation();
  return useMutation({
    mutationFn: ({ requestId, ...input }: { requestId: string; decision: "APPROVED" | "REJECTED"; note?: string | null }) =>
      send<{ budget: BudgetRow }>(`/api/procurement/approvals/${requestId}/decide`, "POST", input, "Couldn't record the decision").then((r) => r.budget),
    onSuccess: (b) => invalidate(b.id),
  });
}

export function useNewBudgetVersion(budgetId: string) {
  const invalidate = useBudgetInvalidation();
  return useMutation({
    mutationFn: () => send<{ budget: BudgetRow }>(`/api/procurement/budgets/${budgetId}/versions`, "POST", undefined, "Couldn't start a new version").then((r) => r.budget),
    onSuccess: (b) => {
      invalidate(budgetId);
      invalidate(b.id);
    },
  });
}

export function useReallocate(budgetId: string) {
  const invalidate = useBudgetInvalidation();
  return useMutation({
    mutationFn: (input: { fromLineKey: string; toLineKey: string; amount: string; reason: string; reportingToAedRate?: string | null }) =>
      send<{ budget: BudgetRow; pendingApprovalId: string | null }>(`/api/procurement/budgets/${budgetId}/reallocate`, "POST", input, "Couldn't move the amount"),
    onSuccess: () => invalidate(budgetId),
  });
}

export type BudgetTransition = "freeze" | "unfreeze" | "close" | "sign-off" | "reopen";

export function useTransitionBudget(budgetId: string) {
  const invalidate = useBudgetInvalidation();
  return useMutation({
    mutationFn: (input: { action: BudgetTransition; reason?: string; varianceNotes?: Record<string, string>; reportingToAedRate?: string | null }) =>
      send<{ budget: BudgetRow }>(`/api/procurement/budgets/${budgetId}/transition`, "POST", input, "Couldn't change the budget's state").then((r) => r.budget),
    onSuccess: () => invalidate(budgetId),
  });
}

export function useDiscardBudget() {
  const invalidate = useBudgetInvalidation();
  return useMutation({
    mutationFn: (budgetId: string) => send<{ discarded: string }>(`/api/procurement/budgets/${budgetId}`, "DELETE", undefined, "Couldn't discard the draft"),
    onSuccess: () => invalidate(),
  });
}
