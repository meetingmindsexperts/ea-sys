"use client";

/**
 * The small pieces every Budget & Procurement page shares: the status badge,
 * the 2 dp money display, the date display, a stat card and the two page
 * states (loading, could-not-load). Lives in the module so a page never
 * imports from another page.
 */

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, TriangleAlert } from "lucide-react";
import { BUDGET_STATUS_LABEL, type BudgetStatus } from "../hooks/use-procurement-api";

const STATUS_CLASS: Record<BudgetStatus, string> = {
  DRAFT: "bg-muted text-foreground",
  UNDER_REVIEW: "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  APPROVED: "bg-primary/10 text-primary",
  ACTIVE: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  FROZEN: "bg-cyan-100 text-cyan-900 dark:bg-cyan-900 dark:text-cyan-100",
  CLOSED: "bg-violet-100 text-violet-900 dark:bg-violet-900 dark:text-violet-100",
  ARCHIVED: "bg-muted text-muted-foreground",
};

/**
 * A category as people read it: its chart code (500300) is the key finance
 * files by, its name (Design, Marketing & Production) is what anyone else
 * recognises, so both show. `stacked` puts the name under the code for table cells.
 */
export function CategoryLabel({ code, name, stacked }: { code: string; name: string; stacked?: boolean }) {
  if (stacked) {
    return (
      <span className="block leading-tight">
        <span className="block font-mono text-[11px]">{code}</span>
        <span className="block">{name}</span>
      </span>
    );
  }
  return (
    <span>
      <span className="font-mono opacity-70">{code}</span> {name}
    </span>
  );
}

export function StatusBadge({ status }: { status: BudgetStatus }) {
  return <Badge className={STATUS_CLASS[status]} variant="secondary">{BUDGET_STATUS_LABEL[status]}</Badge>;
}

export const BRAND_LABEL: Record<string, string> = {
  MMG_EXPERTS: "MM Group Experts",
  MEDCOM: "MedCom",
  MEDULIVE: "MedULive",
};

/** 4-dp stored strings shown at 2 dp with thousands separators; the total is the only place display rounding happens (spec §7). */
export function money2(v: string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "–";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "–";
}

/** A signed 2 dp figure for a delta column: "+1,250.00", "-200.00", "0.00". */
export function signed2(v: string | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n === 0) return "0.00";
  return `${n > 0 ? "+" : "-"}${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtWhen(d: string | null | undefined): string {
  return d ? new Date(d).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "–";
}

export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" }) {
  return (
    <div className={`rounded-lg border bg-card p-3 ${tone === "warn" ? "border-amber-300 dark:border-amber-800" : ""}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="mt-20 flex items-center justify-center text-muted-foreground">
      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
      {label}
    </div>
  );
}

export function ErrorState({ title, message, backHref, backLabel }: { title: string; message: string; backHref?: string; backLabel?: string }) {
  return (
    <div className="mx-auto mt-20 max-w-md rounded-lg border border-amber-300 bg-amber-50 p-6 text-center dark:border-amber-900 dark:bg-amber-950">
      <TriangleAlert className="mx-auto mb-3 h-8 w-8 text-amber-700 dark:text-amber-400" />
      <h2 className="font-semibold text-amber-900 dark:text-amber-100">{title}</h2>
      <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">{message}</p>
      {backHref && (
        <Button asChild variant="secondary" className="mt-4"><Link href={backHref}>{backLabel ?? "Back"}</Link></Button>
      )}
    </div>
  );
}
