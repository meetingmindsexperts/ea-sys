"use client";
/** Presentational bits the spend-request pages and the inbox share, so no page imports another page. */
import { Badge } from "@/components/ui/badge";
import { BUDGET_CHECK_LABEL, SPEND_REQUEST_STATUS_LABEL, type BudgetCheckStatusValue, type SpendRequestStatusValue } from "@/procurement/lib/spend-request-rules";

const STATUS_CLASS: Record<SpendRequestStatusValue, string> = {
  DRAFT: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  SUBMITTED: "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  BUDGET_CHECKED: "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  PENDING_APPROVAL: "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  APPROVED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  AWAITING_SUPPLIER: "bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-100",
  REJECTED: "bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100",
  CANCELLED: "bg-muted text-muted-foreground",
  CONVERTED: "bg-violet-100 text-violet-900 dark:bg-violet-900 dark:text-violet-100",
  CLOSED: "bg-muted text-muted-foreground",
};

export function RequestStatusBadge({ status }: { status: SpendRequestStatusValue }) {
  return <Badge variant="secondary" className={STATUS_CLASS[status] ?? ""}>{SPEND_REQUEST_STATUS_LABEL[status] ?? status}</Badge>;
}

const CHECK_CLASS: Record<BudgetCheckStatusValue, string> = {
  NOT_CHECKED: "bg-muted text-muted-foreground",
  WITHIN_BUDGET: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  OVER_BUDGET: "bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100",
  FROZEN: "bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100",
};

export function BudgetCheckBadge({ status }: { status: BudgetCheckStatusValue }) {
  return <Badge variant="secondary" className={CHECK_CLASS[status] ?? ""}>{BUDGET_CHECK_LABEL[status] ?? status}</Badge>;
}

export const PRIORITY_LABEL: Record<"LOW" | "NORMAL" | "HIGH" | "URGENT", string> = { LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent" };
export const SOURCING_LABEL: Record<"SINGLE_QUOTE" | "COMPETITIVE_QUOTES" | "EXISTING_CONTRACT" | "SOLE_SOURCE", string> = {
  SINGLE_QUOTE: "Single quote",
  COMPETITIVE_QUOTES: "Competitive quotes",
  EXISTING_CONTRACT: "Existing contract",
  SOLE_SOURCE: "Sole source",
};

export function PriorityBadge({ priority }: { priority: keyof typeof PRIORITY_LABEL }) {
  if (priority === "NORMAL") return null;
  const cls = priority === "URGENT" ? "bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100" : priority === "HIGH" ? "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100" : "bg-muted text-muted-foreground";
  return <Badge variant="secondary" className={cls}>{PRIORITY_LABEL[priority]}</Badge>;
}
