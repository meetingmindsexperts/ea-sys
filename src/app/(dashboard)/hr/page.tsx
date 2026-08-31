"use client";

/**
 * /hr — the leave summary. The workbook's "Leave Summary" sheet as a screen, and
 * deliberately the landing page: it is what HR actually reads.
 *
 * Two presentation rules carry meaning rather than taste:
 *
 *   1. NEGATIVE BALANCES ARE SHOWN, never hidden or floored. They are leave
 *      taken in advance, which is legal by agreement and true of four people in
 *      the live data. A zero here would be a lie that costs money.
 *   2. AN EMPLOYEE WITHOUT A FIRST ANNIVERSARY shows entitlement 0 and says so,
 *      because otherwise a balance of -23 reads as a system error rather than as
 *      somebody who has taken leave they have not yet accrued.
 *   3. AN AGREED ENTITLEMENT is marked "agreed" rather than shown as a bare
 *      number. A leaver's final year is negotiated between the employee and
 *      management (owner ruling, Aug 31 2026), so one person legitimately
 *      differs from everyone else — and an unexplained difference reads as a
 *      bug to whoever checks it next.
 */

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useHrSummary, useRollHrLeaveYear, type HrSummaryRow } from "@/hr/hooks/use-hr-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CalendarClock, Loader2, TriangleAlert, CalendarDays, RefreshCw, Users
} from "lucide-react";

function Days({ value, highlightNegative = false }: { value: number; highlightNegative?: boolean }) {
  const negative = value < 0;
  return (
    <span
      className={
        "tabular-nums" +
        (highlightNegative && negative ? " font-semibold text-red-600 dark:text-red-400" : "")
      }
    >
      {value}
    </span>
  );
}

export default function HrSummaryPage() {
  const [includeExited, setIncludeExited] = useState(false);
  const { data, isLoading, isError, error } = useHrSummary(undefined, includeExited);
  const roll = useRollHrLeaveYear();

  async function rerunRoll(fromYear: number) {
    try {
      const r = await roll.mutateAsync(fromYear);
      toast.success(
        `Carried ${fromYear} into ${r.toYear} for ${r.granted} ${r.granted === 1 ? "person" : "people"}` +
          (r.capped.length ? `, ${r.capped.length} capped at the carry-over limit` : "") +
          (r.skipped ? `, ${r.skipped} skipped` : "") +
          ".",
      );
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (isLoading) {
    return (
      <div className="mt-20 flex items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading leave summary…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-auto mt-20 max-w-md rounded-lg border border-amber-300 bg-amber-50 p-6 text-center">
        <TriangleAlert className="mx-auto mb-3 h-8 w-8 text-amber-700" />
        <h2 className="font-semibold text-amber-900">Couldn&apos;t load the HR module</h2>
        <p className="mt-2 text-sm text-amber-800">
          {(error as Error)?.message ??
            "The HR module may not be switched on for this deployment."}
        </p>
      </div>
    );
  }

  const rows = data ?? [];
  // Rows for a year the person was not employed in carry zeros by construction
  // (review H1); they are neither "in advance" nor "awaiting an anniversary".
  const negatives = rows.filter((r) => r.balance.employedInYear && r.balance.annual.balance < 0).length;
  const awaitingFirstYear = rows.filter(
    (r) => r.balance.employedInYear && !r.balance.hasCompletedFirstYear,
  ).length;
  // The roll carries the PREVIOUS year in. On the go-live year there is no
  // previous year in the system (the carry-in is the typed seed), so the
  // button is offered only once somebody's seed year is behind the view.
  const leaveYear = rows[0]?.balance.leaveYear;
  const rollable =
    leaveYear !== undefined &&
    rows.some((r) => r.employee.seedLeaveYear === null || r.employee.seedLeaveYear < leaveYear);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <CalendarClock className="h-6 w-6 text-primary" />
            Leave Summary
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length} employee{rows.length === 1 ? "" : "s"} ·{" "}
            {rows[0]?.balance.leaveYear ?? new Date().getFullYear()} leave year · balances as at{" "}
            {rows[0]?.balance.asOf ?? "today"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="secondary">
            <Link href="/hr/employees">
              <Users className="h-4 w-4" />
              Employees
            </Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/hr/attendance">
              <CalendarDays className="h-4 w-4" />
              Attendance
            </Link>
          </Button>
          <Button variant="ghost" onClick={() => setIncludeExited((v) => !v)}>
            {includeExited ? "Hide leavers" : "Show leavers"}
          </Button>
          {/* The worker rolls the previous year into this one every night
              through January. This re-runs it after a later correction (a
              December entry fixed in March). Idempotent: it recomputes the
              carry-in from the rows, so pressing it twice cannot do harm. */}
          {rollable && (
            <Button
              variant="ghost"
              disabled={roll.isPending}
              title={`Recompute what ${leaveYear - 1} carried into ${leaveYear}`}
              onClick={() => void rerunRoll(leaveYear - 1)}
            >
              {roll.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Re-run carry-over
            </Button>
          )}
        </div>
      </div>

      {(negatives > 0 || awaitingFirstYear > 0) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {negatives > 0 && (
            <span className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              {negatives} with leave taken in advance (negative balance)
            </span>
          )}
          {awaitingFirstYear > 0 && (
            <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {awaitingFirstYear} not yet at their first anniversary (no entitlement yet)
            </span>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Employee</th>
              <th className="px-3 py-2 text-right font-medium">Entitled</th>
              <th className="px-3 py-2 text-right font-medium">Carried in</th>
              <th className="px-3 py-2 text-right font-medium">AL taken</th>
              <th className="px-3 py-2 text-right font-medium">AL balance</th>
              <th className="px-3 py-2 text-right font-medium">Sick (full)</th>
              <th className="px-3 py-2 text-right font-medium">Sick (half)</th>
              <th className="px-3 py-2 text-right font-medium">C-off earned</th>
              <th className="px-3 py-2 text-right font-medium">C-off taken</th>
              <th className="px-3 py-2 text-right font-medium">C-off balance</th>
              <th className="px-3 py-2 text-left font-medium">Next anniversary</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map(({ employee, balance }: HrSummaryRow) => (
              <tr key={employee.id} className="hover:bg-muted/30">
                <td className="px-3 py-2">
                  <div className="font-medium">{employee.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {employee.empCode}
                    {employee.department ? ` · ${employee.department}` : ""}
                    {employee.exitDate ? ` · left ${employee.exitDate}` : ""}
                  </div>
                </td>
                {!balance.employedInYear ? (
                  /* A year the person was not employed in has no balance to show.
                     Rendering the engine's zeros as numbers would read as "took
                     nothing, owed thirty", which is the figure that used to be
                     shown for every pre-year leaver (review H1). Say what it is. */
                  <td colSpan={10} className="px-3 py-2 text-xs text-muted-foreground">
                    Not employed in {balance.leaveYear}
                    {employee.exitDate && employee.exitDate < `${balance.leaveYear}-01-01`
                      ? ` (left ${employee.exitDate})`
                      : ` (joins ${employee.joiningDate})`}
                    . Nothing is counted for this year.
                  </td>
                ) : (
                  <>
                <td className="px-3 py-2 text-right">
                  {/* An agreed figure is shown with a marker rather than silently:
                      a number that differs from everyone else's needs to explain
                      itself, or the next person to read it calls it a bug. It is
                      checked FIRST because an agreement outranks the first-year
                      rule, which is what makes a negotiated leaver's year work. */}
                  {balance.annual.entitlementOverridden ? (
                    <span
                      className="inline-flex items-center gap-1"
                      title="Agreed with management, not the standard rule"
                    >
                      <Days value={balance.annual.entitlement} />
                      <Badge variant="outline" className="text-[10px]">agreed</Badge>
                    </span>
                  ) : balance.hasCompletedFirstYear ? (
                    <Days value={balance.annual.entitlement} />
                  ) : (
                    <Badge variant="outline" className="text-[10px]">
                      first year
                    </Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-right"><Days value={balance.annual.carriedIn} /></td>
                <td className="px-3 py-2 text-right"><Days value={balance.annual.taken} /></td>
                <td className="px-3 py-2 text-right">
                  <Days value={balance.annual.balance} highlightNegative />
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {balance.sick.full.used} / {balance.sick.full.limit}
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {balance.sick.half.used} / {balance.sick.half.limit}
                </td>
                <td className="px-3 py-2 text-right"><Days value={balance.compOff.earned} /></td>
                <td className="px-3 py-2 text-right"><Days value={balance.compOff.taken} /></td>
                <td className="px-3 py-2 text-right">
                  <Days value={balance.compOff.balance} highlightNegative />
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {balance.nextAnniversary}
                </td>
                  </>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-10 text-center text-muted-foreground">
                  No employees yet. Import the workbook, or add someone.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        A negative balance is leave taken in advance and is shown rather than
        floored. Sick leave is the Art. 31 tiers: 15 days full pay, then 30 at
        half pay, then 45 unpaid. A comp-off is earned by working both days of one
        weekend.
      </p>
    </div>
  );
}
