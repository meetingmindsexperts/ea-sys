"use client";

/**
 * The editor's dialogs: header details, submit (with the completeness list),
 * decide (approve or reject with a note), reallocate (the 10% rule shown
 * before the click), and a reason prompt shared by unfreeze and reopen.
 * Each owns its form and re-seeds it on open (the prev-open pattern, no
 * setState in an effect).
 */

import { useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api-fetch";
import { EVENT_BRANDS } from "@/procurement/lib/budget-schemas";
import { CONTINGENCY_CATEGORY_CODE } from "@/procurement/lib/budget-categories-seed";
import { missingForSubmission, reallocationAuthority } from "@/procurement/lib/budget-rules";
import { money, reallocationCap, storedString } from "@/procurement/lib/money";
import { isPeggedToAed } from "@/procurement/lib/close-out";
import { useDecideBudget, useReallocate, useSubmitBudget, useUpdateBudgetHeader, type BudgetCategoryRow, type BudgetRow } from "@/procurement/hooks/use-procurement-api";
import { BRAND_LABEL, money2 } from "@/procurement/components/budget-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";

interface DialogProps { b: BudgetRow; open: boolean; onOpenChange: (o: boolean) => void }

/** Runs `seed` once per opening; the fresh-open flag is decided during render. */
function useSeedOnOpen<T>(open: boolean, seed: () => T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState(seed);
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setState(seed());
  }
  return [state, setState];
}

function RateField({ currency, value, onChange, why }: { currency: string; value: string; onChange: (v: string) => void; why: string }) {
  if (isPeggedToAed(currency)) return null;
  return (
    <div className="space-y-2">
      <Label htmlFor="aed-rate">{`${currency} to AED rate`}</Label>
      <Input id="aed-rate" type="number" min={0} step="any" value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. 4.2" />
      <p className="text-xs text-muted-foreground">{`${why} AED and USD carry a peg; ${currency} needs today's rate (between 2.5 and 8).`}</p>
    </div>
  );
}

export function HeaderDialog({ b, open, onOpenChange }: DialogProps) {
  const update = useUpdateBudgetHeader(b.id);
  const draft = b.status === "DRAFT";
  const [f, setF] = useSeedOnOpen(open, () => ({
    contingencyPercent: String(Number(b.contingencyPercent)),
    expectedAttendance: b.expectedAttendance === null ? "" : String(b.expectedAttendance),
    brand: b.brand ?? "",
    notes: b.notes ?? "",
  }));

  async function save() {
    const attendance = f.expectedAttendance.trim() === "" ? null : Number(f.expectedAttendance);
    if (attendance !== null && (!Number.isInteger(attendance) || attendance < 0)) return toast.error("Expected attendance must be a whole number.");
    const pct = Number(f.contingencyPercent);
    if (draft && (!Number.isFinite(pct) || pct < 0 || pct > 100)) return toast.error("Contingency percent must be between 0 and 100.");
    const patch: Record<string, unknown> = { expectedVersion: b.version };
    if (draft) {
      if (pct !== Number(b.contingencyPercent)) patch.contingencyPercent = f.contingencyPercent.trim();
      if (attendance !== b.expectedAttendance) patch.expectedAttendance = attendance;
      if ((f.brand || null) !== b.brand) patch.brand = f.brand || null;
    }
    if ((f.notes.trim() || null) !== (b.notes ?? null)) patch.notes = f.notes.trim() || null;
    if (Object.keys(patch).length === 1) {
      onOpenChange(false);
      return;
    }
    try {
      await update.mutateAsync(patch as Record<string, unknown> & { expectedVersion: number });
      toast.success("Budget details saved.");
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Budget details</DialogTitle>
          <DialogDescription>
            {draft ? "Contingency, attendance and brand change on a draft; the reporting currency is fixed once the budget has lines." : "On an approved version only the notes change; planned figures, contingency and attendance revise on a new version."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="h-contingency">Contingency %</Label>
            <Input id="h-contingency" type="number" min={0} max={100} step="0.5" value={f.contingencyPercent} disabled={!draft} onChange={(e) => setF((s) => ({ ...s, contingencyPercent: e.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="h-attendance">Expected attendance</Label>
            <Input id="h-attendance" type="number" min={0} value={f.expectedAttendance} disabled={!draft} onChange={(e) => setF((s) => ({ ...s, expectedAttendance: e.target.value }))} placeholder="Required to submit" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Brand</Label>
            <Select value={f.brand || "none"} disabled={!draft} onValueChange={(v) => setF((s) => ({ ...s, brand: v === "none" ? "" : v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not set</SelectItem>
                {EVENT_BRANDS.map((v) => <SelectItem key={v} value={v}>{BRAND_LABEL[v] ?? v}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="h-notes">Notes</Label>
            <Textarea id="h-notes" rows={3} value={f.notes} onChange={(e) => setF((s) => ({ ...s, notes: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={update.isPending}>Cancel</Button>
          <Button onClick={() => void save()} disabled={update.isPending}>
            {update.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SubmitDialog({ b, categories, open, onOpenChange }: DialogProps & { categories: BudgetCategoryRow[] }) {
  const submit = useSubmitBudget(b.id);
  const [rate, setRate] = useSeedOnOpen(open, () => "");
  const [serverMissing, setServerMissing] = useSeedOnOpen<string[] | null>(open, () => null);
  // The same rule the service runs, so the dialog can say what is missing before the click; the server's answer replaces it after.
  const localMissing = missingForSubmission(
    { reportingCurrency: b.reportingCurrency, expectedAttendance: b.expectedAttendance, contingencyPercent: b.contingencyPercent, naCategoryCodes: b.naCategoryCodes },
    (b.lines ?? []).map((l) => ({ categoryId: l.categoryId, isContingency: l.isContingency, deletedAt: null, transactionCurrency: l.transactionCurrency, fxRateToReporting: l.fxRateToReporting })),
    categories.map((c) => ({ id: c.id, code: c.code, depth: c.depth, isActive: c.isActive })),
    CONTINGENCY_CATEGORY_CODE,
  );
  const missing = serverMissing ?? localMissing;
  const needsRate = !isPeggedToAed(b.reportingCurrency);

  async function go() {
    if (needsRate && !(Number(rate) > 0)) return toast.error(`The ${b.reportingCurrency} to AED rate is needed to route the approval.`);
    try {
      await submit.mutateAsync(needsRate ? { reportingToAedRate: rate.trim() } : {});
      toast.success("Submitted for approval.");
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INCOMPLETE") {
        const m = (err.data?.meta as { missing?: string[] } | undefined)?.missing;
        setServerMissing(Array.isArray(m) ? m : [err.message]);
        return;
      }
      toast.error((err as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Submit for approval</DialogTitle>
          <DialogDescription>
            {`${b.reportingCurrency} ${money2(b.plannedExpenseTotal)} planned (ex-VAT) plus ${money2(b.contingencyAmount)} contingency. The approver is chosen on the AED amount; the plan is locked while it is under review.`}
          </DialogDescription>
        </DialogHeader>
        {missing.length > 0 ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950">
            <div className="font-medium text-amber-900 dark:text-amber-100">Not complete enough to submit</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-amber-800 dark:text-amber-200">
              {missing.map((m) => <li key={m}>{m}</li>)}
            </ul>
            <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">Enter a figure on a line for each category, or mark the category not applicable.</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Every category has a line or is marked not applicable, contingency and attendance are set.</p>
        )}
        <RateField currency={b.reportingCurrency} value={rate} onChange={setRate} why="The approver is chosen on the AED amount." />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submit.isPending}>Cancel</Button>
          <Button onClick={() => void go()} disabled={submit.isPending || missing.length > 0}>
            {submit.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DecideDialog({ b, open, onOpenChange }: DialogProps) {
  const decide = useDecideBudget(b.id);
  const [note, setNote] = useSeedOnOpen(open, () => "");
  const [pending, setPending] = useState<"APPROVED" | "REJECTED" | null>(null);

  async function go(decision: "APPROVED" | "REJECTED") {
    setPending(decision);
    try {
      await decide.mutateAsync({ decision, note: note.trim() || null });
      toast.success(decision === "APPROVED" ? "Approved. The budget is now active." : "Rejected. The budget is back with its author as a draft.");
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Decide this budget</DialogTitle>
          <DialogDescription>
            {`${b.eventCode} v${b.versionNo}: ${b.reportingCurrency} ${money2(b.plannedExpenseTotal)} planned plus ${money2(b.contingencyAmount)} contingency. Approving activates this version and archives the previous one; rejecting returns it to draft.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="decide-note">Note (optional, kept on the approval trail)</Label>
          <Textarea id="decide-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={decide.isPending}>Cancel</Button>
          <Button variant="destructive" onClick={() => void go("REJECTED")} disabled={decide.isPending}>
            {pending === "REJECTED" && <Loader2 className="h-4 w-4 animate-spin" />}
            Reject
          </Button>
          <Button onClick={() => void go("APPROVED")} disabled={decide.isPending}>
            {pending === "APPROVED" && <Loader2 className="h-4 w-4 animate-spin" />}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReallocateDialog({ b, open, onOpenChange }: DialogProps) {
  const move = useReallocate(b.id);
  const lines = (b.lines ?? []).filter((l) => !l.isContingency).slice().sort((x, y) => x.sortOrder - y.sortOrder);
  const [f, setF] = useSeedOnOpen(open, () => ({ from: "", to: "", amount: "", reason: "", rate: "" }));
  const from = lines.find((l) => l.lineKey === f.from);
  const amountOk = Number(f.amount) > 0;
  const base = from ? (from.approvedPlanned ?? from.planned) : "0";
  const left = from ? money(reallocationCap(base)).minus(money(from.reallocatedOut)) : money(0);
  const authority = from && amountOk ? reallocationAuthority(from, f.amount) : null;
  const needsRate = authority === "APPROVAL_REQUIRED" && !isPeggedToAed(b.reportingCurrency);

  async function go() {
    if (!from || !f.to) return toast.error("Pick the two lines.");
    if (f.from === f.to) return toast.error("Pick two different lines.");
    if (!amountOk) return toast.error("Enter the amount to move.");
    if (money(from.planned).lt(money(f.amount))) return toast.error(`"${from.description}" holds only ${money2(from.planned)}.`);
    if (!f.reason.trim()) return toast.error("A reallocation needs a reason.");
    if (needsRate && !(Number(f.rate) > 0)) return toast.error(`The ${b.reportingCurrency} to AED rate is needed to route this move for approval.`);
    try {
      const r = await move.mutateAsync({ fromLineKey: f.from, toLineKey: f.to, amount: f.amount.trim(), reason: f.reason.trim(), ...(needsRate ? { reportingToAedRate: f.rate.trim() } : {}) });
      toast.success(r.pendingApprovalId ? "Above your 10% authority: the move is routed for approval." : "Moved. The plan is updated.");
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Move an amount between lines</DialogTitle>
          <DialogDescription>
            Up to 10% of a line&apos;s approved amount moves on your own authority per version; anything beyond routes for approval. Contingency is sized by the percent and never takes part.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>From</Label>
            <Select value={f.from} onValueChange={(v) => setF((s) => ({ ...s, from: v }))}>
              <SelectTrigger><SelectValue placeholder="The line that gives" /></SelectTrigger>
              <SelectContent>
                {lines.map((l) => <SelectItem key={l.lineKey} value={l.lineKey}>{`${l.description} · ${money2(l.planned)}`}</SelectItem>)}
              </SelectContent>
            </Select>
            {from && (
              <p className="text-xs text-muted-foreground">
                {`Approved ${money2(base)}, moved so far ${money2(from.reallocatedOut)}, own authority left ${money2(storedString(left.lt(0) ? money(0) : left))}.`}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>To</Label>
            <Select value={f.to} onValueChange={(v) => setF((s) => ({ ...s, to: v }))}>
              <SelectTrigger><SelectValue placeholder="The line that receives" /></SelectTrigger>
              <SelectContent>
                {lines.filter((l) => l.lineKey !== f.from).map((l) => <SelectItem key={l.lineKey} value={l.lineKey}>{`${l.description} · ${money2(l.planned)}`}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="move-amount">{`Amount (${b.reportingCurrency}, ex-VAT)`}</Label>
            <Input id="move-amount" type="number" min={0} step="any" value={f.amount} onChange={(e) => setF((s) => ({ ...s, amount: e.target.value }))} />
            {authority && (
              <p className={`text-xs ${authority === "OWNER" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}>
                {authority === "OWNER" ? "Within your authority: applies at once." : "Above your 10% authority: an approval request is raised on the AED matrix."}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="move-reason">Reason</Label>
            <Textarea id="move-reason" rows={2} value={f.reason} onChange={(e) => setF((s) => ({ ...s, reason: e.target.value }))} placeholder="Why the plan moves" />
          </div>
          {needsRate && <RateField currency={b.reportingCurrency} value={f.rate} onChange={(v) => setF((s) => ({ ...s, rate: v }))} why="The approver is chosen on the AED amount." />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={move.isPending}>Cancel</Button>
          <Button onClick={() => void go()} disabled={move.isPending}>
            {move.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {authority === "APPROVAL_REQUIRED" ? "Request approval" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReasonDialog({ open, onOpenChange, title, description, confirmLabel, destructive, pending, onConfirm }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  pending: boolean;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const [reason, setReason] = useSeedOnOpen(open, () => "");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reason">Reason (kept on the audit trail)</Label>
          <Textarea id="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={() => { if (!reason.trim()) return toast.error("A reason is required."); void onConfirm(reason.trim()); }} disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
