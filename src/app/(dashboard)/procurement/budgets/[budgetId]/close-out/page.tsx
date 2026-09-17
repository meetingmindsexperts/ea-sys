"use client";

/**
 * /procurement/budgets/[budgetId]/close-out: the close-out of an active or
 * frozen version, then its summary once closed.
 *   Before the close (authors): every line with planned, actual and the
 *   variance; a written note per line the rule flags (past 10% or the
 *   AED-5,000 floor, judged with the same function the service uses); the
 *   notes save on their own or ride with the close.
 *   After the close: the summary the archive row was written from, sign-off
 *   for the settle grant, reopen with a reason for an admin.
 */

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { canAdminProcurement, canAuthorBudgets, canSettleProcurement } from "@/lib/procurement-visibility";
import { ApiError } from "@/lib/api-fetch";
import { isPeggedToAed, keysStillNeedingNote, varianceRows } from "@/procurement/lib/close-out";
import { useBudget, useTransitionBudget, useUpsertBudgetLine, type BudgetLineRow, type BudgetRow } from "@/procurement/hooks/use-procurement-api";
import { CategoryLabel, ErrorState, LoadingState, Stat, StatusBadge, fmtWhen, money2, signed2 } from "@/procurement/components/budget-ui";
import { ReasonDialog } from "../budget-dialogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ArrowLeft, Check, CheckCheck, Loader2, RotateCcw, Save, TriangleAlert } from "lucide-react";

interface CloseOutSummary {
  closedAt?: string;
  plannedExpenseTotal?: string;
  actualTotal?: string;
  contingencyAmount?: string;
  recordedAttendance?: number | null;
  byCategory?: Record<string, { planned: string; actual: string; variance: string }>;
}

export default function CloseOutPage() {
  const { budgetId } = useParams<{ budgetId: string }>();
  const { data: session } = useSession();
  const { data: b, isLoading, isError, error } = useBudget(budgetId);
  const canAuthor = canAuthorBudgets(session?.user);
  const canAdmin = canAdminProcurement(session?.user);
  const canSettle = canSettleProcurement(session?.user);

  if (isLoading) return <LoadingState label="Loading budget…" />;
  if (isError || !b) return <ErrorState title="Couldn't load this budget" message={(error as Error)?.message ?? "It may have been discarded."} backHref="/procurement" backLabel="Back to budgets" />;

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/procurement/budgets/${b.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> {`${b.eventCode} · v${b.versionNo}`}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Close-out</h1>
          <StatusBadge status={b.status} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{`${b.event?.name ?? b.eventCode} · ${b.reportingCurrency}`}</p>
      </div>
      {b.status === "CLOSED" ? (
        <ClosedView b={b} canSettle={canSettle} canAdmin={canAdmin} />
      ) : b.status === "ACTIVE" || b.status === "FROZEN" ? (
        canAuthor ? <CloseForm b={b} /> : <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">The close-out is the author&apos;s: an organiser or above writes the variance notes and closes the version.</div>
      ) : (
        <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">Only the active or frozen version closes. This one is {b.status.toLowerCase().replace("_", " ")}.</div>
      )}
    </div>
  );
}

function CloseForm({ b }: { b: BudgetRow }) {
  const transition = useTransitionBudget(b.id);
  const upsert = useUpsertBudgetLine(b.id);
  const cur = b.reportingCurrency;
  const pegged = isPeggedToAed(cur);
  const lines = (b.lines ?? []).slice().sort((x, y) => (x.isContingency === y.isContingency ? x.sortOrder - y.sortOrder : x.isContingency ? 1 : -1));

  // Drafts start from the notes on the lines, seeded once per budget row
  // (the id, not the version: a save bumps the version and must not wipe
  // what is being typed).
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (seededFor !== b.id) {
    setSeededFor(b.id);
    setDrafts(Object.fromEntries(lines.map((l) => [l.lineKey, l.varianceNote ?? ""])));
  }
  const [rate, setRate] = useState("");
  const [serverKeys, setServerKeys] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const variance = varianceRows(lines.map((l) => ({ lineKey: l.lineKey, planned: l.planned, actual: l.actual, isContingency: l.isContingency, varianceNote: l.varianceNote })), cur, pegged ? undefined : rate || null);
  const rowByKey = new Map(variance.ok ? variance.rows.map((r) => [r.lineKey, r]) : []);
  const stillNeeding = variance.ok ? keysStillNeedingNote(variance.rows, drafts) : [];
  const flagged = new Set([...stillNeeding, ...serverKeys]);
  const changed = lines.filter((l) => (drafts[l.lineKey] ?? "").trim() !== (l.varianceNote ?? "").trim());

  async function saveNotes() {
    setSaving(true);
    try {
      for (const l of changed) await upsert.mutateAsync({ lineId: l.id, varianceNote: (drafts[l.lineKey] ?? "").trim() || null });
      toast.success(`${changed.length} note${changed.length === 1 ? "" : "s"} saved.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function close() {
    const notes: Record<string, string> = {};
    for (const [k, v] of Object.entries(drafts)) if (v.trim()) notes[k] = v.trim();
    try {
      await transition.mutateAsync({ action: "close", varianceNotes: notes, ...(pegged ? {} : { reportingToAedRate: rate.trim() }) });
      toast.success("Closed. The archive row is written; the settle grant signs it off.");
      setConfirmOpen(false);
    } catch (err) {
      setConfirmOpen(false);
      if (err instanceof ApiError && err.code === "VARIANCE_NOTES_REQUIRED") {
        const keys = (err.data?.meta as { lineKeys?: string[] } | undefined)?.lineKeys ?? [];
        setServerKeys(keys);
        toast.error(`${keys.length} line${keys.length === 1 ? " still needs" : "s still need"} a variance note.`);
        return;
      }
      toast.error((err as Error).message);
    }
  }

  const actualTotal = lines.reduce((a, l) => a + Number(l.actual), 0);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Planned (ex-VAT)" value={`${cur} ${money2(b.plannedExpenseTotal)}`} />
        <Stat label="Actual so far" value={`${cur} ${money2(actualTotal.toFixed(4))}`} />
        <Stat label="Contingency" value={`${cur} ${money2(b.contingencyAmount)}`} />
        <Stat label="Notes needed" value={variance.ok ? String(stillNeeding.length) : "–"} sub={variance.ok ? `threshold: 10% or ${cur} ${money2(variance.floorInReporting)}` : "rate needed"} tone={stillNeeding.length > 0 ? "warn" : undefined} />
      </div>

      {!pegged && (
        <div className="grid gap-2 rounded-lg border bg-card p-4 sm:max-w-md">
          <Label htmlFor="close-rate">{`${cur} to AED rate`}</Label>
          <Input id="close-rate" type="number" min={0} step="any" value={rate} onChange={(e) => { setRate(e.target.value); setServerKeys([]); }} placeholder="e.g. 4.2" />
          <p className="text-xs text-muted-foreground">{`Sets the AED-5,000 note floor in ${cur} (spec §14 Q13); between 2.5 and 8.${!variance.ok && variance.rate.reason === "out-of-band" ? " That rate is outside the band." : ""}`}</p>
        </div>
      )}

      <div className="rounded-lg border bg-card">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead>Line</TableHead>
                <TableHead className="text-right">Planned</TableHead>
                <TableHead className="text-right">Actual</TableHead>
                <TableHead className="text-right">Variance</TableHead>
                <TableHead className="min-w-64">Variance note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => {
                const r = rowByKey.get(l.lineKey);
                const needs = flagged.has(l.lineKey);
                return (
                  <TableRow key={l.id} className={l.isContingency ? "bg-muted/40" : needs ? "bg-amber-50/60 dark:bg-amber-950/30" : undefined}>
                    <TableCell className="text-xs text-muted-foreground"><CategoryLabel code={l.category.code} name={l.category.name} stacked /></TableCell>
                    <TableCell>{l.description}</TableCell>
                    <TableCell className="text-right tabular-nums">{money2(l.planned)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money2(l.actual)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r ? (
                        <>
                          <div className={Number(r.variance) > 0 ? "text-amber-700 dark:text-amber-400" : Number(r.variance) < 0 ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}>{signed2(r.variance)}</div>
                          <div className="text-xs text-muted-foreground">{r.variancePercent === null ? "–" : `${r.variancePercent > 0 ? "+" : ""}${r.variancePercent}%`}</div>
                        </>
                      ) : "–"}
                    </TableCell>
                    <TableCell>
                      {l.isContingency ? (
                        <span className="text-xs text-muted-foreground">follows the percent</span>
                      ) : (
                        <NoteCell value={drafts[l.lineKey] ?? ""} needs={needs} required={r?.needsNote ?? false} onChange={(v) => { setDrafts((d) => ({ ...d, [l.lineKey]: v })); if (serverKeys.length) setServerKeys((k) => k.filter((x) => x !== l.lineKey)); }} />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {stillNeeding.length > 0 && (
          <span className="mr-auto inline-flex items-center gap-1 text-sm text-amber-700 dark:text-amber-400">
            <TriangleAlert className="h-4 w-4" />
            {`${stillNeeding.length} line${stillNeeding.length === 1 ? "" : "s"} past the threshold with no note.`}
          </span>
        )}
        <Button variant="outline" onClick={() => void saveNotes()} disabled={saving || changed.length === 0}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          <Save className="h-4 w-4" /> {`Save notes${changed.length ? ` (${changed.length})` : ""}`}
        </Button>
        <Button onClick={() => setConfirmOpen(true)} disabled={transition.isPending || (!pegged && !(Number(rate) > 0))}>
          <CheckCheck className="h-4 w-4" /> Close the budget
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => !transition.isPending && setConfirmOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Close ${b.eventCode} v${b.versionNo}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {`The version becomes read-only, the checked-in attendance is recorded, and the archive row every cross-event report reads is written. ${stillNeeding.length > 0 ? `${stillNeeding.length} line${stillNeeding.length === 1 ? "" : "s"} still need a note; the close will refuse and name them.` : "Every flagged line carries a note."} The settle grant signs off afterwards; an admin can reopen with a reason.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={transition.isPending}>Not yet</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void close(); }} disabled={transition.isPending}>
              {transition.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Close the budget
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function NoteCell({ value, needs, required, onChange }: { value: string; needs: boolean; required: boolean; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)} placeholder={required ? "Required: why actual differs from planned" : "Optional"} className={needs ? "border-amber-400 focus-visible:ring-amber-400" : undefined} aria-invalid={needs || undefined} />
      {needs && <div className="text-xs text-amber-700 dark:text-amber-400">Past the threshold: a note is required to close.</div>}
    </div>
  );
}

function ClosedView({ b, canSettle, canAdmin }: { b: BudgetRow; canSettle: boolean; canAdmin: boolean }) {
  const transition = useTransitionBudget(b.id);
  const [signOpen, setSignOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const cur = b.reportingCurrency;
  const s = (b.closeOutSummary ?? {}) as CloseOutSummary;
  const byCategory = Object.entries(s.byCategory ?? {}).sort((a, z) => a[0].localeCompare(z[0]));
  const lines: BudgetLineRow[] = (b.lines ?? []).filter((l) => l.varianceNote);

  async function signOff() {
    try {
      await transition.mutateAsync({ action: "sign-off" });
      toast.success("Signed off.");
      setSignOpen(false);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  async function reopen(reason: string) {
    try {
      await transition.mutateAsync({ action: "reopen", reason });
      toast.success("Reopened. The close-out and sign-off are undone.");
      setReopenOpen(false);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const actual = s.actualTotal ?? "0";
  const planned = s.plannedExpenseTotal ?? b.plannedExpenseTotal;
  const totalVariance = (Number(actual) - Number(planned)).toFixed(4);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Planned (ex-VAT)" value={`${cur} ${money2(planned)}`} />
        <Stat label="Actual" value={`${cur} ${money2(actual)}`} sub={`variance ${signed2(totalVariance)}`} />
        <Stat label="Contingency" value={`${cur} ${money2(s.contingencyAmount ?? b.contingencyAmount)}`} />
        <Stat label="Recorded attendance" value={String(s.recordedAttendance ?? b.recordedAttendance ?? "–")} sub="checked in, faculty excluded" />
      </div>

      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-3"><span className="text-muted-foreground">Closed</span><div>{fmtWhen(b.closedAt)}</div></div>
        <div className="rounded-lg border bg-card p-3"><span className="text-muted-foreground">Signed off</span><div>{b.signedOffAt ? fmtWhen(b.signedOffAt) : "awaiting the settle grant"}</div></div>
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
          {canSettle && !b.signedOffAt && <Button size="sm" onClick={() => setSignOpen(true)}><Check className="h-4 w-4" /> Sign off</Button>}
          {canAdmin && <Button size="sm" variant="outline" onClick={() => setReopenOpen(true)}><RotateCcw className="h-4 w-4" /> Reopen</Button>}
          {!canAdmin && (!canSettle || b.signedOffAt) && (
            <span className="text-xs text-muted-foreground">
              {b.signedOffAt ? "Settled. Only an admin can reopen it, with a reason." : "Sign-off is the settle grant's; reopening is an admin's."}
            </span>
          )}
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Planned</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead className="text-right">Variance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {byCategory.map(([code, v]) => (
              <TableRow key={code}>
                <TableCell>{code}</TableCell>
                <TableCell className="text-right tabular-nums">{money2(v.planned)}</TableCell>
                <TableCell className="text-right tabular-nums">{money2(v.actual)}</TableCell>
                <TableCell className={`text-right tabular-nums ${Number(v.variance) > 0 ? "text-amber-700 dark:text-amber-400" : Number(v.variance) < 0 ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}>{signed2(v.variance)}</TableCell>
              </TableRow>
            ))}
            {byCategory.length === 0 && <TableRow><TableCell colSpan={4} className="py-6 text-center text-muted-foreground">No category totals were recorded.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>

      {lines.length > 0 && (
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-2 text-sm font-medium">Variance notes</div>
          <ul className="space-y-2 text-sm">
            {lines.map((l) => (
              <li key={l.id}>
                <span className="font-medium">{l.description}</span>
                <span className="text-muted-foreground">{` (${money2(l.planned)} planned, ${money2(l.actual)} actual): `}</span>
                {l.varianceNote}
              </li>
            ))}
          </ul>
        </div>
      )}

      <AlertDialog open={signOpen} onOpenChange={(o) => !transition.isPending && setSignOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign off this close-out?</AlertDialogTitle>
            <AlertDialogDescription>You confirm the summary above is settled. Only an admin can reopen it afterwards, with a reason.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={transition.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void signOff(); }} disabled={transition.isPending}>
              {transition.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Sign off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ReasonDialog open={reopenOpen} onOpenChange={setReopenOpen} title="Reopen this closed budget?" description="The close-out and any sign-off are undone; the archive row is rewritten when it closes again. Say why." confirmLabel="Reopen" pending={transition.isPending} onConfirm={reopen} />
    </div>
  );
}
