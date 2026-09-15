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
import type { BudgetCheckStatusValue, SpendRequestStatusValue } from "@/procurement/lib/spend-request-rules";
import type { CommitmentStatusValue, FulfillmentStatusValue } from "@/procurement/lib/commitment-rules";

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
  /** Who can decide beside the assignee, named by the approval-escalation job after 48 hours. */
  delegateName: string | null;
  dueAt: string | null;
  status: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  note: string | null;
}

export interface ApprovalRequestRow {
  id: string;
  subjectType: "BUDGET" | "BUDGET_REALLOCATION" | "SPEND_REQUEST";
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
  /** Present when the subject is a spend request: what the inbox card needs without opening it. */
  spendRequest: {
    id: string;
    requestNo: string;
    title: string;
    status: SpendRequestStatusValue;
    budgetCheckStatus: BudgetCheckStatusValue;
    lineKey: string | null;
    lineDescription: string | null;
    vendor: string | null;
    supplierApproved: boolean;
    exception: boolean;
    kind: "SUBMISSION" | "AMENDMENT" | null;
    amendment: { previousAmount: string; nextAmount: string; deltaReporting: string; reason: string } | null;
    remainingAfter: string | null;
  } | null;
  steps: ApprovalStepRow[];
}

export interface SupplierContact {
  name: string;
  email?: string;
  phone?: string;
  role?: string;
}
export interface SupplierBankDetails {
  bankName?: string;
  accountName?: string;
  iban?: string;
  swift?: string;
  accountNumber?: string;
}
export interface SupplierRow {
  id: string;
  code: string;
  legalName: string;
  displayName: string;
  /** Null when redacted for this reader (see financialsRedacted). */
  taxRegistrationNo: string | null;
  country: string | null;
  currency: string;
  contacts: SupplierContact[];
  paymentTerms: string | null;
  bankDetails: SupplierBankDetails | null;
  externalSystemType: string | null;
  externalVendorId: string | null;
  approvalStatus: "PROPOSED" | "APPROVED" | "REJECTED";
  riskStatus: "NONE" | "WATCH" | "BLOCKED";
  isActive: boolean;
  notes: string | null;
  proposedByUserId: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  financialsRedacted: boolean;
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

export interface SpendRequestQuoteRow {
  id: string;
  vendorName: string;
  supplierId: string | null;
  supplier: { id: string; code: string; displayName: string; approvalStatus: string } | null;
  amount: string;
  taxAmount: string;
  currency: string;
  quotedOn: string | null;
  validUntil: string | null;
  recommended: boolean;
  notes: string | null;
  fileUrl: string | null;
  fileName: string | null;
  fileMimeType: string | null;
  fileSize: number | null;
  createdAt: string;
}

/** What the requests list needs to know about a request's order; the detail carries the whole CommitmentRow. */
export interface OrderSummaryRow {
  id: string;
  commitmentNo: string;
  status: CommitmentStatusValue;
  fulfillmentStatus: FulfillmentStatusValue;
  fulfillmentLabel: string;
  sentToSupplierAt: string | null;
  receiptConfirmedAt: string | null;
}

export interface SpendRequestRow {
  id: string;
  requestNo: string;
  budgetId: string | null;
  lineKey: string | null;
  eventCode: string;
  requesterUserId: string;
  requesterName: string | null;
  supplierId: string | null;
  supplier: { id: string; code: string; displayName: string; approvalStatus: string; isActive: boolean } | null;
  proposedVendorName: string | null;
  title: string;
  justification: string | null;
  amount: string;
  taxAmount: string;
  currency: string;
  fxRateToReporting: string | null;
  amountReporting: string | null;
  amountAed: string | null;
  categoryId: string | null;
  category: { id: string; code: string; name: string } | null;
  neededBy: string | null;
  sourcingMethod: "SINGLE_QUOTE" | "COMPETITIVE_QUOTES" | "EXISTING_CONTRACT" | "SOLE_SOURCE" | null;
  budgetCheckStatus: BudgetCheckStatusValue;
  status: SpendRequestStatusValue;
  statusLabel: string;
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  linkedCommitmentId: string | null;
  emailSupplierOnIssue: boolean;
  order: OrderSummaryRow | null;
  approvalRequestId: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  decidedByUserId: string | null;
  decisionNote: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  budget: { id: string; eventCode: string; versionNo: number; status: BudgetStatus; reportingCurrency: string; event: { name: string } | null } | null;
  quotes: SpendRequestQuoteRow[];
}

export interface SpendRequestLineRow {
  lineKey: string;
  description: string;
  planned: string;
  committedOpen: string;
  actual: string;
  remaining: string;
  isContingency: boolean;
  category: { id: string; code: string; name: string };
}

export interface CommitmentLineRow {
  id: string;
  lineKey: string;
  categoryId: string | null;
  description: string;
  qty: string;
  unitCost: string;
  taxCode: string | null;
  taxRatePercent: string | null;
  amount: string;
  taxAmount: string;
  sortOrder: number;
}

export interface CommitmentRow {
  id: string;
  commitmentNo: string;
  spendRequestId: string | null;
  budgetId: string | null;
  lineKey: string;
  supplierId: string;
  eventCode: string;
  amount: string;
  taxAmount: string;
  currency: string;
  fxRateToReporting: string;
  amountReporting: string;
  amountAed: string | null;
  status: CommitmentStatusValue;
  statusLabel: string;
  fulfillmentStatus: FulfillmentStatusValue;
  fulfillmentLabel: string;
  accountingSyncStatus: string;
  approvedAt: string;
  approvedByUserId: string | null;
  sentToSupplierAt: string | null;
  receivedAt: string | null;
  receivedByUserId: string | null;
  receiptConfirmedAt: string | null;
  receiptConfirmedByUserId: string | null;
  receiptNeedsSecondPerson: boolean;
  receiptConfirmed: boolean;
  emailSupplierOnIssue: boolean;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  cancelReason: string | null;
  version: number;
  createdAt: string;
  supplier: { id: string; code: string; displayName: string; legalName: string; country: string | null; currency: string; paymentTerms: string | null; approvalStatus: string; isActive: boolean; contactEmails: { name: string; email: string }[] };
  spendRequest: { id: string; requestNo: string; title: string; requesterUserId: string; amountAed: string | null; emailSupplierOnIssue: boolean } | null;
  budget: { id: string; eventCode: string; versionNo: number; status: BudgetStatus; reportingCurrency: string; event: { name: string } | null } | null;
  lines: CommitmentLineRow[];
}

export interface CommitmentDetailRow extends CommitmentRow {
  requesterName: string | null;
  approvedByName: string | null;
  receivedByName: string | null;
  receiptConfirmedByName: string | null;
  cancelledByName: string | null;
}

export interface SpendRequestDetailRow extends SpendRequestRow {
  decidedByName: string | null;
  line: SpendRequestLineRow | null;
  /** The purchase order this request became; null until approval issues it, and again after a cancel. */
  order: CommitmentRow | null;
  /** Cancelled orders the request held before, newest first. */
  previousOrders: CommitmentRow[];
  approvals: {
    id: string;
    status: string;
    amountAed: string;
    payload: Record<string, unknown> | null;
    createdAt: string;
    decidedAt: string | null;
    steps: { assigneeUserId: string; assigneeName: string | null; delegateUserId: string | null; delegateName: string | null; status: string; decidedByUserId: string | null; decidedByName: string | null; decidedAt: string | null; note: string | null; dueAt: string }[];
  }[];
}

export interface BudgetCheckPreviewRow {
  budget: { id: string; eventCode: string; versionNo: number; status: BudgetStatus; reportingCurrency: string };
  line: SpendRequestLineRow;
  requestToReportingRate: string;
  rateSource: "same" | "peg" | "caller";
  check: { status: Exclude<BudgetCheckStatusValue, "NOT_CHECKED">; exception: boolean; reasonRequired: boolean; amountReporting: string; remainingBefore: string; remainingAfter: string };
  amountAed: string | null;
  route: { ok: true; approverUserId: string; approverName: string | null; exception: boolean } | { ok: false; code: "NO_APPROVER" | "RATE_REQUIRED"; message: string };
  openRequests: { id: string; requestNo: string; title: string; status: SpendRequestStatusValue; amountReporting: string | null }[];
}

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
  approvals: (scope: ApprovalScope) => ["procurement", "approvals", scope] as const,
  categories: () => ["procurement", "categories"] as const,
  products: () => ["procurement", "products"] as const,
  suppliers: (status?: string, includeInactive?: boolean) => ["procurement", "suppliers", status ?? "all", includeInactive ? "all" : "active"] as const,
  templates: () => ["procurement", "templates"] as const,
  requests: (filter: string) => ["procurement", "requests", filter] as const,
  request: (requestId: string) => ["procurement", "request", requestId] as const,
  budgetCheck: (key: string) => ["procurement", "budget-check", key] as const,
  commitments: (filter: string) => ["procurement", "commitments", filter] as const,
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

export function useSuppliers(filter: { status?: "PROPOSED" | "APPROVED" | "REJECTED"; includeInactive?: boolean } = {}) {
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.includeInactive) q.set("includeInactive", "1");
  const qs = q.toString();
  return useQuery({
    queryKey: procurementKeys.suppliers(filter.status, filter.includeInactive),
    queryFn: () => get<{ suppliers: SupplierRow[] }>(`/api/procurement/suppliers${qs ? `?${qs}` : ""}`).then((r) => r.suppliers),
  });
}

function useSupplierInvalidation() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["procurement", "suppliers"] });
}

export interface ProposeSupplierInput {
  code?: string;
  legalName: string;
  displayName?: string;
  taxRegistrationNo?: string | null;
  country?: string | null;
  currency: string;
  contacts?: SupplierContact[];
  paymentTerms?: string | null;
  notes?: string | null;
}

export function useProposeSupplier() {
  const invalidate = useSupplierInvalidation();
  return useMutation({
    mutationFn: (input: ProposeSupplierInput) => send<{ supplier: SupplierRow }>("/api/procurement/suppliers", "POST", input, "Couldn't save the supplier").then((r) => r.supplier),
    onSuccess: invalidate,
  });
}

export function useDecideSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ supplierId, ...input }: { supplierId: string; decision: "APPROVED" | "REJECTED"; note?: string | null }) =>
      send<{ supplier: SupplierRow; ordersIssued: number; ordersFailed: number; ordersEmailFailed: number }>(`/api/procurement/suppliers/${supplierId}/decide`, "POST", input, "Couldn't record the decision"),
    // Approving a supplier issues the orders waiting on it and moves line figures: every procurement screen may have changed.
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["procurement"] }),
  });
}

export interface UpdateSupplierInput {
  supplierId: string;
  expectedVersion: number;
  legalName?: string;
  displayName?: string;
  taxRegistrationNo?: string | null;
  country?: string | null;
  currency?: string;
  contacts?: SupplierContact[];
  paymentTerms?: string | null;
  bankDetails?: SupplierBankDetails | null;
  riskStatus?: "NONE" | "WATCH" | "BLOCKED";
  isActive?: boolean;
  notes?: string | null;
}

export function useUpdateSupplier() {
  const invalidate = useSupplierInvalidation();
  return useMutation({
    mutationFn: ({ supplierId, ...input }: UpdateSupplierInput) =>
      send<{ supplier: SupplierRow }>(`/api/procurement/suppliers/${supplierId}`, "PATCH", input, "Couldn't save the supplier").then((r) => r.supplier),
    onSuccess: invalidate,
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

export interface CsvImportResult {
  totalProcessed: number;
  created: number;
  updated?: number;
  unchanged?: number;
  skipped?: number;
  skippedDetails?: string[];
  /** Suppliers only: whether the created rows landed approved (settle grant) or as Proposed. */
  approved?: boolean;
  errors: string[];
}

export function useImportBudgetProducts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (csv: string) => send<CsvImportResult>("/api/procurement/products/import", "POST", { csv }, "Couldn't import the products"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: procurementKeys.products() }),
  });
}

export function useImportSuppliers() {
  const invalidate = useSupplierInvalidation();
  return useMutation({
    mutationFn: (csv: string) => send<CsvImportResult>("/api/procurement/suppliers/import", "POST", { csv }, "Couldn't import the suppliers"),
    onSuccess: invalidate,
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

export type ApprovalScope = "inbox" | "mine" | "decided";
export function useApprovals(scope: ApprovalScope) {
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, ...input }: { requestId: string; decision: "APPROVED" | "REJECTED"; note?: string | null }) =>
      send<{ budget?: BudgetRow; spendRequest?: SpendRequestDetailRow; autoSend?: AutoSendRow | null }>(`/api/procurement/approvals/${requestId}/decide`, "POST", input, "Couldn't record the decision"),
    onSuccess: (r) => {
      invalidate(r.budget?.id ?? r.spendRequest?.budgetId ?? undefined);
      void qc.invalidateQueries({ queryKey: ["procurement", "requests"] });
      if (r.spendRequest) void qc.invalidateQueries({ queryKey: procurementKeys.request(r.spendRequest.id) });
    },
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

// ── spend requests ───────────────────────────────────────────────────────────

export function useSpendRequests(filter: { status?: SpendRequestStatusValue; budgetId?: string; mine?: boolean } = {}) {
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.budgetId) q.set("budgetId", filter.budgetId);
  if (filter.mine) q.set("mine", "1");
  const qs = q.toString();
  return useQuery({
    queryKey: procurementKeys.requests(qs || "all"),
    queryFn: () => get<{ requests: SpendRequestRow[] }>(`/api/procurement/requests${qs ? `?${qs}` : ""}`).then((r) => r.requests),
  });
}

export function useSpendRequest(requestId: string | null) {
  return useQuery({
    queryKey: procurementKeys.request(requestId ?? "none"),
    queryFn: () => get<{ request: SpendRequestDetailRow }>(`/api/procurement/requests/${requestId}`).then((r) => r.request),
    enabled: !!requestId,
  });
}

export interface BudgetCheckQuery {
  budgetId: string;
  lineKey: string;
  amount: string;
  currency: string;
  fxRateToReporting?: string | null;
  reportingToAedRate?: string | null;
  excludeRequestId?: string | null;
}

/** The live side panel: refetched as the requester types (the caller debounces), never cached across forms. */
export function useBudgetCheckPreview(query: BudgetCheckQuery | null) {
  const q = new URLSearchParams();
  if (query) {
    q.set("budgetId", query.budgetId);
    q.set("lineKey", query.lineKey);
    q.set("amount", query.amount);
    q.set("currency", query.currency);
    if (query.fxRateToReporting) q.set("fxRateToReporting", query.fxRateToReporting);
    if (query.reportingToAedRate) q.set("reportingToAedRate", query.reportingToAedRate);
    if (query.excludeRequestId) q.set("excludeRequestId", query.excludeRequestId);
  }
  const qs = q.toString();
  return useQuery({
    queryKey: procurementKeys.budgetCheck(qs),
    queryFn: () => get<{ preview: BudgetCheckPreviewRow }>(`/api/procurement/requests/budget-check?${qs}`).then((r) => r.preview),
    enabled: !!query && Number(query.amount) > 0,
    staleTime: 15_000,
    retry: false,
  });
}

function useSpendRequestInvalidation() {
  const qc = useQueryClient();
  return (r: { id: string; budgetId: string | null }) => {
    void qc.invalidateQueries({ queryKey: ["procurement", "requests"] });
    void qc.invalidateQueries({ queryKey: procurementKeys.request(r.id) });
    void qc.invalidateQueries({ queryKey: ["procurement", "approvals"] });
    void qc.invalidateQueries({ queryKey: ["procurement", "budget-check"] });
    if (r.budgetId) void qc.invalidateQueries({ queryKey: procurementKeys.budget(r.budgetId) });
  };
}

export interface SpendRequestInput {
  budgetId: string;
  lineKey?: string | null;
  title: string;
  justification?: string | null;
  amount: string;
  taxAmount?: string | null;
  currency: string;
  fxRateToReporting?: string | null;
  supplierId?: string | null;
  proposedVendorName?: string | null;
  categoryId?: string | null;
  neededBy?: string | null;
  sourcingMethod?: SpendRequestRow["sourcingMethod"];
  priority?: SpendRequestRow["priority"];
  emailSupplierOnIssue?: boolean;
}

export function useCreateSpendRequest() {
  const invalidate = useSpendRequestInvalidation();
  return useMutation({
    mutationFn: (input: SpendRequestInput) => send<{ request: SpendRequestDetailRow }>("/api/procurement/requests", "POST", input, "Couldn't create the request").then((r) => r.request),
    onSuccess: invalidate,
  });
}

export function useUpdateSpendRequest(requestId: string) {
  const invalidate = useSpendRequestInvalidation();
  return useMutation({
    mutationFn: (input: Partial<SpendRequestInput> & { expectedVersion: number }) =>
      send<{ request: SpendRequestDetailRow }>(`/api/procurement/requests/${requestId}`, "PATCH", input, "Couldn't save the request").then((r) => r.request),
    onSuccess: invalidate,
  });
}

export function useSubmitSpendRequest(requestId: string) {
  const invalidate = useSpendRequestInvalidation();
  return useMutation({
    mutationFn: (input: { expectedVersion: number; reportingToAedRate?: string | null }) =>
      send<{ request: SpendRequestDetailRow }>(`/api/procurement/requests/${requestId}/submit`, "POST", input, "Couldn't submit the request").then((r) => r.request),
    onSuccess: invalidate,
  });
}

export function useTransitionSpendRequest(requestId: string) {
  const invalidate = useSpendRequestInvalidation();
  return useMutation({
    mutationFn: (input: { action: "withdraw" | "cancel"; reason?: string | null; expectedVersion: number }) =>
      send<{ request: SpendRequestDetailRow }>(`/api/procurement/requests/${requestId}/transition`, "POST", input, "Couldn't update the request").then((r) => r.request),
    onSuccess: invalidate,
  });
}

export function useAmendSpendRequest(requestId: string) {
  const invalidate = useSpendRequestInvalidation();
  return useMutation({
    mutationFn: (input: { amount: string; taxAmount?: string | null; reason: string; reportingToAedRate?: string | null; expectedVersion: number }) =>
      send<{ request: SpendRequestDetailRow }>(`/api/procurement/requests/${requestId}/amend`, "POST", input, "Couldn't change the amount").then((r) => r.request),
    onSuccess: invalidate,
  });
}

export interface QuoteInput {
  vendorName: string;
  supplierId?: string | null;
  amount: string;
  taxAmount?: string | null;
  currency: string;
  quotedOn?: string | null;
  validUntil?: string | null;
  recommended?: boolean;
  notes?: string | null;
}

export function useAddQuote(requestId: string) {
  const invalidate = useSpendRequestInvalidation();
  return useMutation({
    mutationFn: (input: QuoteInput) => send<{ request: SpendRequestDetailRow }>(`/api/procurement/requests/${requestId}/quotes`, "POST", input, "Couldn't attach the quote").then((r) => r.request),
    onSuccess: invalidate,
  });
}

export function useRemoveQuote(requestId: string) {
  const invalidate = useSpendRequestInvalidation();
  return useMutation({
    mutationFn: (quoteId: string) => send<{ request: SpendRequestDetailRow }>(`/api/procurement/requests/${requestId}/quotes/${quoteId}`, "DELETE", undefined, "Couldn't remove the quote").then((r) => r.request),
    onSuccess: invalidate,
  });
}

// ── purchase orders (slice 3) ────────────────────────────────────────────────

export function useCommitments(filter: { status?: CommitmentStatusValue; budgetId?: string; supplierId?: string } = {}) {
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.budgetId) q.set("budgetId", filter.budgetId);
  if (filter.supplierId) q.set("supplierId", filter.supplierId);
  const qs = q.toString();
  return useQuery({
    queryKey: procurementKeys.commitments(qs || "all"),
    queryFn: () => get<{ commitments: (CommitmentRow & { requesterName: string | null })[] }>(`/api/procurement/commitments${qs ? `?${qs}` : ""}`).then((r) => r.commitments),
  });
}

/** Every order mutation refreshes the request it belongs to, the lists, and the budget whose line it moved. */
/** What became of the automatic supplier email an order was issued with. */
export type AutoSendRow = { requested: false } | { requested: true; sent: true } | { requested: true; sent: false; code: string };
/** Where a cancelled order's request went: back to its approver, or to draft when nobody can take it. */
export type RerouteRow = { status: "PENDING_APPROVAL"; approvalRequestId: string; exception: boolean } | { status: "DRAFT"; reason: string } | { status: "UNCHANGED" };

function useOrderInvalidation() {
  const qc = useQueryClient();
  return (c: { spendRequestId: string | null; budgetId: string | null }) => {
    void qc.invalidateQueries({ queryKey: ["procurement", "requests"] });
    void qc.invalidateQueries({ queryKey: ["procurement", "commitments"] });
    void qc.invalidateQueries({ queryKey: ["procurement", "budget-check"] });
    if (c.spendRequestId) void qc.invalidateQueries({ queryKey: procurementKeys.request(c.spendRequestId) });
    if (c.budgetId) void qc.invalidateQueries({ queryKey: procurementKeys.budget(c.budgetId) });
  };
}

/** The manual raise, for recovery or re-issue; approval issues the order by itself. */
export function useRaiseOrder(requestId: string) {
  const invalidate = useOrderInvalidation();
  return useMutation({
    mutationFn: () => send<{ commitment: CommitmentDetailRow; autoSend: AutoSendRow | null }>(`/api/procurement/requests/${requestId}/order`, "POST", undefined, "Couldn't raise the purchase order"),
    onSuccess: (r) => invalidate(r.commitment),
  });
}

export function useSendOrder(commitmentId: string) {
  const invalidate = useOrderInvalidation();
  return useMutation({
    mutationFn: () => send<{ commitment: CommitmentDetailRow }>(`/api/procurement/commitments/${commitmentId}/send`, "POST", undefined, "Couldn't send the order").then((r) => r.commitment),
    onSuccess: invalidate,
  });
}

export function useReceiveOrder(commitmentId: string) {
  const invalidate = useOrderInvalidation();
  return useMutation({
    mutationFn: (input: { extent: "PARTIAL" | "FULL"; expectedVersion: number }) =>
      send<{ commitment: CommitmentDetailRow }>(`/api/procurement/commitments/${commitmentId}/receive`, "POST", input, "Couldn't record the receipt").then((r) => r.commitment),
    onSuccess: invalidate,
  });
}

export function useConfirmReceipt(commitmentId: string) {
  const invalidate = useOrderInvalidation();
  return useMutation({
    mutationFn: (input: { expectedVersion: number }) =>
      send<{ commitment: CommitmentDetailRow }>(`/api/procurement/commitments/${commitmentId}/confirm-receipt`, "POST", input, "Couldn't confirm the receipt").then((r) => r.commitment),
    onSuccess: invalidate,
  });
}

export function useCancelOrder(commitmentId: string) {
  const invalidate = useOrderInvalidation();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { reason: string; expectedVersion: number }) =>
      send<{ commitment: CommitmentDetailRow; reroute: RerouteRow | null }>(`/api/procurement/commitments/${commitmentId}/cancel`, "POST", input, "Couldn't cancel the order"),
    onSuccess: (r) => {
      invalidate(r.commitment);
      // The request went back to an approver: their inbox changed too.
      void qc.invalidateQueries({ queryKey: ["procurement", "approvals"] });
    },
  });
}

/** The quote document: multipart, so it bypasses the JSON `send` helper on purpose. */
export function useUploadQuoteFile(requestId: string) {
  const invalidate = useSpendRequestInvalidation();
  return useMutation({
    mutationFn: async ({ quoteId, file }: { quoteId: string; file: File }) => {
      const form = new FormData();
      form.append("file", file);
      const r = await apiFetch<{ request: SpendRequestDetailRow }>(`/api/procurement/requests/${requestId}/quotes/${quoteId}/file`, { method: "POST", body: form });
      return r.request;
    },
    onSuccess: invalidate,
  });
}

export function useRemoveQuoteFile(requestId: string) {
  const invalidate = useSpendRequestInvalidation();
  return useMutation({
    mutationFn: (quoteId: string) => send<{ request: SpendRequestDetailRow }>(`/api/procurement/requests/${requestId}/quotes/${quoteId}/file`, "DELETE", undefined, "Couldn't remove the file").then((r) => r.request),
    onSuccess: invalidate,
  });
}
