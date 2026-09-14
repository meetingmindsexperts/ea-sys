"use client";

/**
 * /procurement/budgets/[budgetId], one budget version: the editor. What the
 * page offers is keyed on the version's status and on who is looking (the
 * same predicates the routes ask, so a hidden control is one the API would
 * refuse anyway):
 *   DRAFT         lines and header edit inline, categories are marked not
 *                 applicable, submit and discard (authors);
 *   UNDER_REVIEW  read-only; approve or reject for an approval grant,
 *                 withdraw for the author;
 *   ACTIVE        reallocate within the 10% rule, freeze, new version,
 *                 close out (authors); forecasts still edit;
 *   FROZEN        unfreeze (admins), close out (authors);
 *   CLOSED        sign off (the settle grant), reopen with a reason (admins);
 *   ARCHIVED      read-only, superseded.
 * Version compare and close-out are their own pages; the action bar links.
 */

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { approvalCeilingAed, canAdminProcurement, canAuthorBudgets, canSettleProcurement } from "@/lib/procurement-visibility";
import { ApiError } from "@/lib/api-fetch";
import { downloadExport } from "@/lib/export-download";
import { CONTINGENCY_CATEGORY_CODE } from "@/procurement/lib/budget-categories-seed";
import {
  procurementKeys,
  useApprovals,
  useBudget,
  useBudgetCategories,
  useDiscardBudget,
  useNewBudgetVersion,
  useTransitionBudget,
  useUpdateBudgetHeader,
  type BudgetCategoryRow,
  type BudgetRow,
} from "@/procurement/hooks/use-procurement-api";
import { BRAND_LABEL, ErrorState, LoadingState, Stat, StatusBadge, fmtWhen, money2 } from "@/procurement/components/budget-ui";
import { BudgetActivityCard } from "@/procurement/components/budget-activity-card";
import { BudgetLinesTable, lineCategories, type LinesMode } from "./budget-lines-table";
import { DecideDialog, HeaderDialog, ReallocateDialog, ReasonDialog, SubmitDialog } from "./budget-dialogs";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ArrowLeft, ArrowLeftRight, Check, CheckCheck, ClipboardCheck, Download, GitCompare, Loader2, Lock, PencilLine, RotateCcw, Send, Snowflake, Trash2, TriangleAlert, Unlock } from "lucide-react";

type Confirm = "discard" | "freeze" | "signoff" | "newversion" | null;
type Prompt = "unfreeze" | "reopen" | null;

export default function BudgetEditorPage() {
  const { budgetId } = useParams<{ budgetId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { data: session } = useSession();
  const { data: b, isLoading, isError, error } = useBudget(budgetId);
  const { data: categories = [] } = useBudgetCategories();
  const { data: mine = [] } = useApprovals("mine");

  const canAuthor = canAuthorBudgets(session?.user);
  const canAdmin = canAdminProcurement(session?.user);
  const canSettle = canSettleProcurement(session?.user);
  const canDecide = approvalCeilingAed(session?.user) !== null;

  const [headerOpen, setHeaderOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [decideOpen, setDecideOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);

  const discard = useDiscardBudget();
  const transition = useTransitionBudget(budgetId);
  const newVersion = useNewBudgetVersion(budgetId);

  if (isLoading) return <LoadingState label="Loading budget…" />;
  if (isError || !b) return <ErrorState title="Couldn't load this budget" message={(error as Error)?.message ?? "It may have been discarded."} backHref="/procurement" backLabel="Back to budgets" />;

  const cur = b.reportingCurrency;
  const open = b.status !== "CLOSED" && b.status !== "ARCHIVED";
  const mode: LinesMode = canAuthor && b.status === "DRAFT" ? "plan" : canAuthor && (b.status === "ACTIVE" || b.status === "FROZEN") ? "forecast" : "read";
  const pendingMoves = mine.filter((r) => r.subjectId === b.id && r.subjectType === "BUDGET_REALLOCATION" && r.status === "PENDING").length;

  function failed(err: unknown) {
    const message = (err as Error).message;
    toast.error(message);
    // A stale write means the page is behind: pull the fresh row so the next click carries the right version.
    if (err instanceof ApiError && err.code === "STALE_WRITE") void qc.invalidateQueries({ queryKey: procurementKeys.budget(b!.id) });
  }

  async function runConfirm() {
    if (!b) return;
    try {
      if (confirm === "discard") {
        await discard.mutateAsync(b.id);
        toast.success(`${b.eventCode} v${b.versionNo} discarded.`);
        setConfirm(null);
        router.push("/procurement");
        return;
      }
      if (confirm === "freeze") {
        await transition.mutateAsync({ action: "freeze" });
        toast.success("Frozen. The plan is locked; forecasts still move.");
      } else if (confirm === "signoff") {
        await transition.mutateAsync({ action: "sign-off" });
        toast.success("Signed off.");
      } else if (confirm === "newversion") {
        const nb = await newVersion.mutateAsync();
        toast.success(`Version ${nb.versionNo} created as a draft.`);
        setConfirm(null);
        router.push(`/procurement/budgets/${nb.id}`);
        return;
      }
      setConfirm(null);
    } catch (err) {
      failed(err);
    }
  }

  async function runPrompt(reason: string) {
    if (!b) return;
    try {
      await transition.mutateAsync({ action: prompt === "unfreeze" ? "unfreeze" : "reopen", reason });
      toast.success(prompt === "unfreeze" ? "Unfrozen. The budget is active again." : "Reopened. The close-out and sign-off are undone.");
      setPrompt(null);
    } catch (err) {
      failed(err);
    }
  }

  async function exportCsv() {
    if (!b) return;
    const r = await downloadExport({
      url: `/api/procurement/budgets/${b.id}/export`,
      filename: `budget-${b.eventCode}-v${b.versionNo}.csv`,
      logKey: "procurement-budget:export-failed",
      forbiddenMessage: "You cannot export this budget.",
    });
    if (!r.ok) toast.error(r.error ?? "Export failed.");
  }

  const confirmText: Record<Exclude<Confirm, null>, { title: string; body: string; label: string; destructive?: boolean }> = {
    discard: { title: `Discard ${b.eventCode} v${b.versionNo}?`, body: b.status === "UNDER_REVIEW" ? "This withdraws the pending approval request and deletes the version. Nothing else changes." : "The draft and its lines are deleted. Nothing else changes.", label: "Discard", destructive: true },
    freeze: { title: "Freeze this budget?", body: "The plan is locked: no reallocation and no new lines until an admin unfreezes it. Forecasts and notes still move, and the budget can still be closed.", label: "Freeze" },
    signoff: { title: "Sign off this close-out?", body: "You confirm the close-out summary is settled. Only an admin can reopen it afterwards, with a reason.", label: "Sign off" },
    newversion: { title: "Start a new version?", body: "A draft copy of this version is created with every line and figure. This version stays active until the new one is approved, and is archived then.", label: "Create draft" },
  };
  const promptText: Record<Exclude<Prompt, null>, { title: string; body: string; label: string }> = {
    unfreeze: { title: "Unfreeze this budget?", body: "The plan opens again for reallocation. Say why.", label: "Unfreeze" },
    reopen: { title: "Reopen this closed budget?", body: "The close-out and any sign-off are undone; the archive row is rewritten when it closes again. Say why.", label: "Reopen" },
  };
  const busy = transition.isPending || discard.isPending || newVersion.isPending;

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
            <span className="inline-flex items-center gap-1 text-sm text-amber-700 dark:text-amber-400"><TriangleAlert className="h-4 w-4" /> at risk</span>
          )}
          {pendingMoves > 0 && <span className="text-sm text-amber-700 dark:text-amber-400">{`${pendingMoves} reallocation${pendingMoves === 1 ? "" : "s"} awaiting approval`}</span>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {`${b.event?.name ? `${b.event.name} · ` : ""}${cur} · contingency ${Number(b.contingencyPercent)}% · ${b.expectedAttendance ?? "no"} expected attendance${b.recordedAttendance !== null && b.recordedAttendance !== undefined ? ` · ${b.recordedAttendance} recorded` : ""}${b.brand ? ` · ${BRAND_LABEL[b.brand] ?? b.brand}` : ""}`}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Planned (ex-VAT)" value={`${cur} ${money2(b.plannedExpenseTotal)}`} sub={`tax ${money2(b.taxTotalPlanned)}`} />
        <Stat label="Contingency" value={`${cur} ${money2(b.contingencyAmount)}`} sub="outside planned" />
        <Stat label="Forecast" value={`${cur} ${money2(b.forecastTotal)}`} tone={b.atRisk ? "warn" : undefined} sub={b.atRisk ? "exceeds planned plus contingency" : undefined} />
        <Stat label="Not applicable" value={String(b.naCategoryCodes.length)} sub={b.naCategoryCodes.join(", ") || "no categories marked"} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_16rem]">
        <div className="min-w-0 space-y-5">
          <NaCategoryChips b={b} categories={categories} editable={mode === "plan"} onFailed={failed} />
          <BudgetLinesTable b={b} categories={categories} mode={mode} />
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg border bg-card p-3"><span className="text-muted-foreground">Submitted</span><div>{fmtWhen(b.submittedAt)}</div></div>
            <div className="rounded-lg border bg-card p-3"><span className="text-muted-foreground">Approved</span><div>{fmtWhen(b.approvedAt)}</div></div>
            <div className="rounded-lg border bg-card p-3"><span className="text-muted-foreground">Frozen</span><div>{fmtWhen(b.frozenAt)}</div></div>
            <div className="rounded-lg border bg-card p-3"><span className="text-muted-foreground">Closed</span><div>{fmtWhen(b.closedAt)}</div></div>
            <div className="rounded-lg border bg-card p-3"><span className="text-muted-foreground">Signed off</span><div>{fmtWhen(b.signedOffAt)}</div></div>
            {b.notes && <div className="rounded-lg border bg-card p-3"><span className="text-muted-foreground">Notes</span><div className="whitespace-pre-line">{b.notes}</div></div>}
          </div>
          <BudgetActivityCard budgetId={b.id} />
        </div>

        <aside className="space-y-2 lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-lg border bg-card p-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Actions</div>
            <div className="flex flex-col gap-2">
              {b.status === "DRAFT" && canAuthor && (
                <>
                  <Button onClick={() => setSubmitOpen(true)}><Send className="h-4 w-4" /> Submit for approval</Button>
                  <Button variant="outline" onClick={() => setHeaderOpen(true)}><PencilLine className="h-4 w-4" /> Edit details</Button>
                  <Button variant="outline" className="text-destructive" onClick={() => setConfirm("discard")}><Trash2 className="h-4 w-4" /> Discard draft</Button>
                </>
              )}
              {b.status === "DRAFT" && !canAuthor && <Note>A draft. Its author fills the lines and submits it.</Note>}
              {b.status === "UNDER_REVIEW" && (
                <>
                  <Note>{`Submitted ${fmtWhen(b.submittedAt)}, awaiting approval on the AED matrix.`}</Note>
                  {canDecide && <Button onClick={() => setDecideOpen(true)}><ClipboardCheck className="h-4 w-4" /> Approve or reject</Button>}
                  {canAuthor && <Button variant="outline" className="text-destructive" onClick={() => setConfirm("discard")}><Trash2 className="h-4 w-4" /> Withdraw</Button>}
                </>
              )}
              {b.status === "ACTIVE" && canAuthor && (
                <>
                  <Button onClick={() => setMoveOpen(true)}><ArrowLeftRight className="h-4 w-4" /> Move an amount</Button>
                  <Button variant="outline" asChild><Link href={`/procurement/budgets/${b.id}/close-out`}><CheckCheck className="h-4 w-4" /> Close out</Link></Button>
                  <Button variant="outline" onClick={() => setConfirm("newversion")}><GitCompare className="h-4 w-4" /> New version</Button>
                  <Button variant="outline" onClick={() => setConfirm("freeze")}><Snowflake className="h-4 w-4" /> Freeze</Button>
                </>
              )}
              {b.status === "FROZEN" && (
                <>
                  <Note>{`Frozen ${fmtWhen(b.frozenAt)}. The plan is locked; forecasts still move.`}</Note>
                  {canAdmin && <Button onClick={() => setPrompt("unfreeze")}><Unlock className="h-4 w-4" /> Unfreeze</Button>}
                  {canAuthor && <Button variant="outline" asChild><Link href={`/procurement/budgets/${b.id}/close-out`}><CheckCheck className="h-4 w-4" /> Close out</Link></Button>}
                </>
              )}
              {b.status === "CLOSED" && (
                <>
                  <Note>{b.signedOffAt ? `Closed ${fmtWhen(b.closedAt)}, signed off ${fmtWhen(b.signedOffAt)}.` : `Closed ${fmtWhen(b.closedAt)}, awaiting sign-off by the settle grant.`}</Note>
                  <Button variant="outline" asChild><Link href={`/procurement/budgets/${b.id}/close-out`}><ClipboardCheck className="h-4 w-4" /> Close-out summary</Link></Button>
                  {canSettle && !b.signedOffAt && <Button onClick={() => setConfirm("signoff")}><Check className="h-4 w-4" /> Sign off</Button>}
                  {canAdmin && <Button variant="outline" onClick={() => setPrompt("reopen")}><RotateCcw className="h-4 w-4" /> Reopen</Button>}
                </>
              )}
              {b.status === "ARCHIVED" && <Note>Superseded by a later version; kept for the record.</Note>}
              {b.status === "APPROVED" && <Note>Approved and awaiting activation.</Note>}
              {open && b.status !== "DRAFT" && canAuthor && (
                <Button variant="ghost" size="sm" onClick={() => setHeaderOpen(true)}><PencilLine className="h-4 w-4" /> Edit notes</Button>
              )}
              {b.eventId && (
                <Button variant="ghost" size="sm" asChild><Link href={`/procurement/budgets/${b.id}/compare`}><GitCompare className="h-4 w-4" /> Compare versions</Link></Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => void exportCsv()}><Download className="h-4 w-4" /> Export CSV</Button>
            </div>
          </div>
          {mode === "plan" && (
            <p className="px-1 text-xs text-muted-foreground">Planned figures are ex-VAT in the transaction currency; a foreign line carries its own rate to {cur}. The contingency line follows the percent.</p>
          )}
          {mode === "forecast" && (
            <p className="px-1 text-xs text-muted-foreground">The plan is approved. Edit a line to set a forecast override with its reason; planned figures revise on a new version.</p>
          )}
          {b.status === "ACTIVE" && !canAuthor && !canDecide && <p className="px-1 text-xs text-muted-foreground"><Lock className="mr-1 inline h-3 w-3" />Read-only for your role.</p>}
        </aside>
      </div>

      <HeaderDialog b={b} open={headerOpen} onOpenChange={setHeaderOpen} />
      <SubmitDialog b={b} categories={categories} open={submitOpen} onOpenChange={setSubmitOpen} />
      <DecideDialog b={b} open={decideOpen} onOpenChange={setDecideOpen} />
      <ReallocateDialog b={b} open={moveOpen} onOpenChange={setMoveOpen} />
      <ReasonDialog
        open={prompt !== null}
        onOpenChange={(o) => !o && setPrompt(null)}
        title={prompt ? promptText[prompt].title : ""}
        description={prompt ? promptText[prompt].body : ""}
        confirmLabel={prompt ? promptText[prompt].label : ""}
        pending={transition.isPending}
        onConfirm={runPrompt}
      />
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm ? confirmText[confirm].title : ""}</AlertDialogTitle>
            <AlertDialogDescription>{confirm ? confirmText[confirm].body : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={confirm && confirmText[confirm].destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
              onClick={(e) => { e.preventDefault(); void runConfirm(); }}
              disabled={busy}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {confirm ? confirmText[confirm].label : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">{children}</p>;
}

/**
 * Spec §6a: every top-level expense category has lines or is marked not
 * applicable before the budget submits. One chip per category: covered
 * (has a line), not applicable (marked), or open (neither, so it blocks
 * submission). Marking goes through the header write with the version lock.
 */
function NaCategoryChips({ b, categories, editable, onFailed }: { b: BudgetRow; categories: BudgetCategoryRow[]; editable: boolean; onFailed: (err: unknown) => void }) {
  const update = useUpdateBudgetHeader(b.id);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const cats = lineCategories(categories);
  if (cats.length === 0) return null;
  const covered = new Set((b.lines ?? []).filter((l) => !l.isContingency).map((l) => l.categoryId));
  const na = new Set(b.naCategoryCodes);
  const open = cats.filter((c) => !covered.has(c.id) && !na.has(c.code) && c.code !== CONTINGENCY_CATEGORY_CODE);

  async function toggle(code: string) {
    const next = na.has(code) ? b.naCategoryCodes.filter((c) => c !== code) : [...b.naCategoryCodes, code];
    setPendingCode(code);
    try {
      await update.mutateAsync({ expectedVersion: b.version, naCategoryCodes: next });
    } catch (err) {
      onFailed(err);
    } finally {
      setPendingCode(null);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-medium">Categories</div>
        <div className="text-xs text-muted-foreground">
          {editable
            ? open.length > 0
              ? `${open.length} still need${open.length === 1 ? "s" : ""} a line or the not-applicable mark before submission.`
              : "Every category has a line or is marked not applicable."
            : "Grey chips were marked not applicable."}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {cats.map((c) => {
          const isNa = na.has(c.code);
          const isCovered = covered.has(c.id);
          const cls = isNa
            ? "border-slate-300 bg-slate-100 text-slate-500 line-through dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400"
            : isCovered
              ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100"
              : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100";
          const title = isNa ? "Marked not applicable" : isCovered ? "Has a line" : "No line yet and not marked not applicable";
          return editable ? (
            <button
              key={c.id}
              type="button"
              title={`${title}. Click to ${isNa ? "clear the mark" : "mark not applicable"}.`}
              disabled={update.isPending}
              onClick={() => void toggle(c.code)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition hover:opacity-80 disabled:opacity-60 ${cls}`}
            >
              {pendingCode === c.code && <Loader2 className="h-3 w-3 animate-spin" />}
              {c.code}
            </button>
          ) : (
            <span key={c.id} title={title} className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs ${cls}`}>{c.code}</span>
          );
        })}
      </div>
    </div>
  );
}
