"use client";

/**
 * /procurement/budgets/[budgetId], one budget version with its lines. The
 * editor's controls (lines, submit, reallocate, freeze, close, sign-off,
 * versions) land with the workflow pages; this page reads.
 */

import { useParams } from "next/navigation";
import Link from "next/link";
import { useBudget, type BudgetLineRow } from "@/procurement/hooks/use-procurement-api";
import { StatusBadge, money2 } from "../../page";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Loader2, TriangleAlert } from "lucide-react";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function when(d: string | null | undefined): string {
  return d ? new Date(d).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "–";
}

export default function BudgetPage() {
  const { budgetId } = useParams<{ budgetId: string }>();
  const { data: b, isLoading, isError, error } = useBudget(budgetId);

  if (isLoading) {
    return (
      <div className="mt-20 flex items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading budget…
      </div>
    );
  }
  if (isError || !b) {
    return (
      <div className="mx-auto mt-20 max-w-md rounded-lg border border-amber-300 bg-amber-50 p-6 text-center">
        <TriangleAlert className="mx-auto mb-3 h-8 w-8 text-amber-700" />
        <h2 className="font-semibold text-amber-900">Couldn&apos;t load this budget</h2>
        <p className="mt-2 text-sm text-amber-800">{(error as Error)?.message ?? "It may have been discarded."}</p>
        <Button asChild variant="secondary" className="mt-4"><Link href="/procurement">Back to budgets</Link></Button>
      </div>
    );
  }

  const lines = (b.lines ?? []).slice().sort((x, y) => (x.isContingency === y.isContingency ? x.sortOrder - y.sortOrder : x.isContingency ? 1 : -1));
  const cur = b.reportingCurrency;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/procurement" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Budgets
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{b.eventCode} · v{b.versionNo}</h1>
          <StatusBadge status={b.status} />
          {b.atRisk && (b.status === "ACTIVE" || b.status === "FROZEN") && (
            <span className="inline-flex items-center gap-1 text-sm text-amber-700"><TriangleAlert className="h-4 w-4" /> at risk</span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {`${cur} · contingency ${Number(b.contingencyPercent)}% · ${b.expectedAttendance ?? "no"} expected attendance${b.recordedAttendance !== null && b.recordedAttendance !== undefined ? ` · ${b.recordedAttendance} recorded` : ""}`}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Planned (ex-VAT)" value={`${cur} ${money2(b.plannedExpenseTotal)}`} sub={`tax ${money2(b.taxTotalPlanned)}`} />
        <Stat label="Contingency" value={`${cur} ${money2(b.contingencyAmount)}`} sub="outside planned" />
        <Stat label="Forecast" value={`${cur} ${money2(b.forecastTotal)}`} />
        <Stat label="Not applicable" value={String(b.naCategoryCodes.length)} sub={b.naCategoryCodes.join(", ") || "no categories marked"} />
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead>Line</TableHead>
              <TableHead className="text-right">Planned</TableHead>
              <TableHead className="text-right">Committed</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead className="text-right">Forecast</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => <LineRow key={l.id} l={l} cur={cur} />)}
            {lines.length === 0 && (
              <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">No lines yet.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-3"><span className="text-muted-foreground">Submitted</span><div>{when(b.submittedAt)}</div></div>
        <div className="rounded-lg border bg-card p-3"><span className="text-muted-foreground">Approved</span><div>{when(b.approvedAt)}</div></div>
        <div className="rounded-lg border bg-card p-3"><span className="text-muted-foreground">Frozen</span><div>{when(b.frozenAt)}</div></div>
        <div className="rounded-lg border bg-card p-3"><span className="text-muted-foreground">Closed</span><div>{when(b.closedAt)}</div></div>
        <div className="rounded-lg border bg-card p-3"><span className="text-muted-foreground">Signed off</span><div>{when(b.signedOffAt)}</div></div>
        {b.notes && <div className="rounded-lg border bg-card p-3"><span className="text-muted-foreground">Notes</span><div className="whitespace-pre-line">{b.notes}</div></div>}
      </div>
    </div>
  );
}

function LineRow({ l, cur }: { l: BudgetLineRow; cur: string }) {
  const foreign = l.transactionCurrency !== cur;
  const remainingNeg = Number(l.remaining) < 0;
  return (
    <TableRow className={l.isContingency ? "bg-muted/40" : undefined}>
      <TableCell className="text-xs text-muted-foreground">{l.category.code}</TableCell>
      <TableCell>
        <div>{l.description}</div>
        {foreign && <div className="text-xs text-muted-foreground">{l.transactionCurrency} {money2(l.unitCost)} × {Number(l.qty)} at {Number(l.fxRateToReporting)}</div>}
        {l.forecastFinalAmount && <div className="text-xs text-amber-700">forecast override: {l.forecastReason}</div>}
        {l.varianceNote && <div className="text-xs text-muted-foreground">variance note: {l.varianceNote}</div>}
      </TableCell>
      <TableCell className="text-right tabular-nums">{money2(l.planned)}</TableCell>
      <TableCell className="text-right tabular-nums">{money2(l.committedTotal)}</TableCell>
      <TableCell className="text-right tabular-nums">{money2(l.actual)}</TableCell>
      <TableCell className="text-right tabular-nums">{money2(l.paid)}</TableCell>
      <TableCell className={`text-right tabular-nums ${remainingNeg ? "font-semibold text-red-600" : ""}`}>{money2(l.remaining)}</TableCell>
      <TableCell className="text-right tabular-nums">{money2(l.forecast)}</TableCell>
    </TableRow>
  );
}
