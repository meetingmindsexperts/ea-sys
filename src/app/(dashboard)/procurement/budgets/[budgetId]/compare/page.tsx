"use client";

/**
 * /procurement/budgets/[budgetId]/compare: two versions of the same event's
 * budget side by side, paired by lineKey (a clone keeps the key), with the
 * planned delta per line and per total. Reads only; the versions are picked
 * from the event's list, defaulting to this version against the one before it.
 */

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useBudget, useBudgets, type BudgetRow } from "@/procurement/hooks/use-procurement-api";
import { compareSummary, compareVersions, type CompareChange } from "@/procurement/lib/version-compare";
import { ErrorState, LoadingState, StatusBadge, money2, signed2 } from "@/procurement/components/budget-ui";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Loader2 } from "lucide-react";

const CHANGE_LABEL: Record<CompareChange, { text: string; cls: string }> = {
  added: { text: "added", cls: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100" },
  removed: { text: "removed", cls: "bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100" },
  changed: { text: "changed", cls: "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100" },
  unchanged: { text: "same", cls: "bg-muted text-muted-foreground" },
};

function deltaClass(v: string): string {
  const n = Number(v);
  return n > 0 ? "text-amber-700 dark:text-amber-400" : n < 0 ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground";
}

export default function CompareVersionsPage() {
  const { budgetId } = useParams<{ budgetId: string }>();
  const { data: current, isLoading, isError, error } = useBudget(budgetId);
  const { data: all = [] } = useBudgets();
  const eventId = current?.eventId ?? null;
  const versions = all.filter((v) => eventId !== null && v.eventId === eventId).sort((a, b) => b.versionNo - a.versionNo);

  const [picked, setPicked] = useState<{ base: string; target: string } | null>(null);
  // Defaults once the versions are known: this version against the one before it (or the newest other one).
  const targetId = picked?.target ?? budgetId;
  const defaultBase = versions.find((v) => v.id !== targetId && current && v.versionNo < current.versionNo)?.id ?? versions.find((v) => v.id !== targetId)?.id ?? null;
  const baseId = picked?.base ?? defaultBase;

  const { data: base, isLoading: baseLoading } = useBudget(baseId);
  const { data: target, isLoading: targetLoading } = useBudget(targetId);

  if (isLoading) return <LoadingState label="Loading budget…" />;
  if (isError || !current) return <ErrorState title="Couldn't load this budget" message={(error as Error)?.message ?? "It may have been discarded."} backHref="/procurement" backLabel="Back to budgets" />;

  const toLines = (b: BudgetRow | undefined) => (b?.lines ?? []).map((l) => ({ lineKey: l.lineKey, categoryCode: l.category.code, description: l.description, planned: l.planned, isContingency: l.isContingency, sortOrder: l.sortOrder }));
  const rows = base && target ? compareVersions(toLines(base), toLines(target)) : [];
  const summary = compareSummary(rows);
  const cur = current.reportingCurrency;
  const label = (v: BudgetRow) => `v${v.versionNo}`;

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/procurement/budgets/${budgetId}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> {`${current.eventCode} · v${current.versionNo}`}
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">Compare versions</h1>
        <p className="mt-1 text-sm text-muted-foreground">{`${current.event?.name ?? current.eventCode} · ${versions.length} version${versions.length === 1 ? "" : "s"} · lines are paired by their key, which a new version keeps.`}</p>
      </div>

      {versions.length < 2 ? (
        <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">This event has one budget version, so there is nothing to compare yet. A new version starts from the active one.</div>
      ) : (
        <>
          <div className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
            <VersionPicker label="Base" value={baseId ?? ""} versions={versions} onChange={(v) => setPicked({ base: v, target: targetId })} />
            <VersionPicker label="Compare to" value={targetId} versions={versions} onChange={(v) => setPicked({ base: baseId ?? "", target: v })} />
          </div>

          {baseLoading || targetLoading || !base || !target ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Loading versions…</div>
          ) : (
            <>
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Total</TableHead>
                      <TableHead className="text-right">{label(base)}</TableHead>
                      <TableHead className="text-right">{label(target)}</TableHead>
                      <TableHead className="text-right">Delta</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TotalRow name={`Planned (ex-VAT, ${cur})`} a={base.plannedExpenseTotal} b={target.plannedExpenseTotal} />
                    <TotalRow name="Planned tax" a={base.taxTotalPlanned} b={target.taxTotalPlanned} />
                    <TotalRow name={`Contingency (${Number(base.contingencyPercent)}% → ${Number(target.contingencyPercent)}%)`} a={base.contingencyAmount} b={target.contingencyAmount} />
                    <TotalRow name="Forecast" a={base.forecastTotal} b={target.forecastTotal} />
                    <TableRow>
                      <TableCell>Expected attendance</TableCell>
                      <TableCell className="text-right tabular-nums">{base.expectedAttendance ?? "–"}</TableCell>
                      <TableCell className="text-right tabular-nums">{target.expectedAttendance ?? "–"}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{base.expectedAttendance !== null && target.expectedAttendance !== null ? (target.expectedAttendance - base.expectedAttendance || "0") : "–"}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>Not applicable</TableCell>
                      <TableCell className="text-right text-xs">{base.naCategoryCodes.join(", ") || "–"}</TableCell>
                      <TableCell className="text-right text-xs">{target.naCategoryCodes.join(", ") || "–"}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{naDelta(base.naCategoryCodes, target.naCategoryCodes)}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>Status</TableCell>
                      <TableCell className="text-right"><StatusBadge status={base.status} /></TableCell>
                      <TableCell className="text-right"><StatusBadge status={target.status} /></TableCell>
                      <TableCell />
                    </TableRow>
                  </TableBody>
                </Table>
              </div>

              <p className="text-sm text-muted-foreground">
                {`${summary.changed} changed · ${summary.added} added · ${summary.removed} removed · ${summary.unchanged} unchanged · net planned movement ${cur} ${signed2(summary.netDelta)} (contingency excluded, it follows the percent).`}
              </p>

              <div className="rounded-lg border bg-card">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead>Line</TableHead>
                        <TableHead className="text-right">{label(base)}</TableHead>
                        <TableHead className="text-right">{label(target)}</TableHead>
                        <TableHead className="text-right">Delta</TableHead>
                        <TableHead>Change</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.lineKey} className={r.isContingency ? "bg-muted/40" : undefined}>
                          <TableCell className="text-xs text-muted-foreground">{r.categoryCode}</TableCell>
                          <TableCell>
                            <div className={r.change === "removed" ? "text-muted-foreground line-through" : undefined}>{r.description}</div>
                            {r.descriptionChanged && <div className="text-xs text-muted-foreground">renamed on this version</div>}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{r.basePlanned === null ? "–" : money2(r.basePlanned)}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.targetPlanned === null ? "–" : money2(r.targetPlanned)}</TableCell>
                          <TableCell className={`text-right tabular-nums ${deltaClass(r.delta)}`}>{signed2(r.delta)}</TableCell>
                          <TableCell><Badge variant="secondary" className={CHANGE_LABEL[r.change].cls}>{CHANGE_LABEL[r.change].text}</Badge></TableCell>
                        </TableRow>
                      ))}
                      {rows.length === 0 && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">Neither version has lines.</TableCell></TableRow>}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function VersionPicker({ label, value, versions, onChange }: { label: string; value: string; versions: BudgetRow[]; onChange: (id: string) => void }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue placeholder="Pick a version" /></SelectTrigger>
        <SelectContent>
          {versions.map((v) => (
            <SelectItem key={v.id} value={v.id}>{`v${v.versionNo} · ${v.status.toLowerCase().replace("_", " ")} · ${v.reportingCurrency} ${money2(v.plannedExpenseTotal)}`}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function TotalRow({ name, a, b }: { name: string; a: string; b: string }) {
  const delta = (Number(b) - Number(a)).toFixed(4);
  return (
    <TableRow>
      <TableCell>{name}</TableCell>
      <TableCell className="text-right tabular-nums">{money2(a)}</TableCell>
      <TableCell className="text-right tabular-nums">{money2(b)}</TableCell>
      <TableCell className={`text-right tabular-nums ${deltaClass(delta)}`}>{signed2(delta)}</TableCell>
    </TableRow>
  );
}

function naDelta(a: string[], b: string[]): string {
  const added = b.filter((c) => !a.includes(c));
  const removed = a.filter((c) => !b.includes(c));
  const parts = [...added.map((c) => `+${c}`), ...removed.map((c) => `−${c}`)];
  return parts.length ? parts.join(" ") : "same";
}
