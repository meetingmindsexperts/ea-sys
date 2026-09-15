"use client";
/**
 * The spend request form (spec §6: "spend request form with a live budget
 * side panel"). The left column is the request; the right column answers,
 * as the requester types, what the line has left, what the budget check
 * will say and who would decide, from the same rules the submit runs. The
 * form creates or edits a DRAFT only; submitting is a separate step on the
 * request page, because the check and the routing are recorded there.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AED_PEG_RATES } from "@/procurement/lib/money";
import { BUDGET_CURRENCIES } from "@/procurement/lib/budget-schemas";
import {
  useBudget,
  useBudgetCheckPreview,
  useBudgets,
  useCreateSpendRequest,
  useSuppliers,
  useUpdateSpendRequest,
  type BudgetCheckQuery,
  type SpendRequestDetailRow,
  type SpendRequestInput,
} from "@/procurement/hooks/use-procurement-api";
import { money2, signed2 } from "@/procurement/components/budget-ui";
import { BudgetCheckBadge, PRIORITY_LABEL, SOURCING_LABEL } from "@/procurement/components/spend-request-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, ShieldAlert, TriangleAlert } from "lucide-react";

type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
type Sourcing = "SINGLE_QUOTE" | "COMPETITIVE_QUOTES" | "EXISTING_CONTRACT" | "SOLE_SOURCE";
const NONE = "__none__";

interface FormState {
  budgetId: string;
  lineKey: string;
  title: string;
  amount: string;
  taxAmount: string;
  currency: string;
  fxRateToReporting: string;
  supplierId: string;
  proposedVendorName: string;
  neededBy: string;
  sourcingMethod: Sourcing | "";
  priority: Priority;
  justification: string;
  emailSupplierOnIssue: boolean;
}

function initial(r?: SpendRequestDetailRow): FormState {
  return {
    budgetId: r?.budgetId ?? "",
    lineKey: r?.lineKey ?? "",
    title: r?.title ?? "",
    amount: r ? money2(r.amount).replace(/,/g, "") : "",
    taxAmount: r && Number(r.taxAmount) > 0 ? money2(r.taxAmount).replace(/,/g, "") : "",
    currency: r?.currency ?? "",
    fxRateToReporting: r?.fxRateToReporting ?? "",
    supplierId: r?.supplierId ?? "",
    proposedVendorName: r?.proposedVendorName ?? "",
    neededBy: r?.neededBy ?? "",
    sourcingMethod: r?.sourcingMethod ?? "",
    priority: r?.priority ?? "NORMAL",
    justification: r?.justification ?? "",
    emailSupplierOnIssue: r?.emailSupplierOnIssue ?? false,
  };
}

/** Both currencies pegged to AED, or the same: the rate is a fact and the field stays hidden. */
function rateIsDerived(requestCurrency: string, reportingCurrency: string): boolean {
  if (!requestCurrency || !reportingCurrency) return true;
  if (requestCurrency === reportingCurrency) return true;
  return AED_PEG_RATES[requestCurrency] !== undefined && AED_PEG_RATES[reportingCurrency] !== undefined;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function SpendRequestForm({ request, onSaved, onCancel }: { request?: SpendRequestDetailRow; onSaved: (r: SpendRequestDetailRow) => void; onCancel?: () => void }) {
  const [f, setF] = useState<FormState>(() => initial(request));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const budgets = useBudgets();
  const suppliers = useSuppliers();
  /** The automatic send needs somewhere to go: a contact with an email on the chosen supplier. */
  const supplierHasEmail = !!(suppliers.data ?? []).find((s) => s.id === f.supplierId)?.contacts?.some((c) => !!c.email);
  const budget = useBudget(f.budgetId || null);
  const create = useCreateSpendRequest();
  const update = useUpdateSpendRequest(request?.id ?? "");

  const openBudgets = useMemo(() => (budgets.data ?? []).filter((b) => b.status === "ACTIVE" || b.status === "FROZEN"), [budgets.data]);
  const reporting = budget.data?.reportingCurrency ?? "";
  const lines = useMemo(() => (budget.data?.lines ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder), [budget.data]);
  const derived = rateIsDerived(f.currency, reporting);

  // The currency follows the budget until the requester picks one.
  const currency = f.currency || reporting;

  const query: BudgetCheckQuery | null = f.budgetId && f.lineKey && Number(f.amount) > 0 && currency && (derived || Number(f.fxRateToReporting) > 0)
    ? { budgetId: f.budgetId, lineKey: f.lineKey, amount: f.amount, currency, fxRateToReporting: derived ? null : f.fxRateToReporting, excludeRequestId: request?.id ?? null }
    : null;
  const debounced = useDebounced(query, 400);
  const preview = useBudgetCheckPreview(debounced);

  const saving = create.isPending || update.isPending;
  const canSave = !!f.budgetId && !!f.title.trim() && Number(f.amount) > 0 && !!currency && (derived || Number(f.fxRateToReporting) > 0);

  async function save() {
    const payload: SpendRequestInput = {
      budgetId: f.budgetId,
      lineKey: f.lineKey || null,
      title: f.title.trim(),
      justification: f.justification.trim() || null,
      amount: f.amount,
      taxAmount: f.taxAmount || null,
      currency,
      fxRateToReporting: derived ? null : f.fxRateToReporting,
      supplierId: f.supplierId || null,
      proposedVendorName: f.supplierId ? null : f.proposedVendorName.trim() || null,
      neededBy: f.neededBy || null,
      sourcingMethod: f.sourcingMethod || null,
      priority: f.priority,
      // Saved as it is SHOWN: the switch reads off when the chosen supplier has no email, so the stored flag must too.
      emailSupplierOnIssue: f.emailSupplierOnIssue && supplierHasEmail,
    };
    try {
      const saved = request ? await update.mutateAsync({ ...payload, expectedVersion: request.version }) : await create.mutateAsync(payload);
      toast.success(request ? "Saved." : `Draft ${saved.requestNo} created. Attach a quote, then submit.`);
      onSaved(saved);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const selectedLine = lines.find((l) => l.lineKey === f.lineKey);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-5">
        <section className="space-y-3 rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">Where the money comes from</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="sr-budget">Event budget</Label>
              <Select value={f.budgetId} onValueChange={(v) => { set("budgetId", v); set("lineKey", ""); set("currency", ""); }}>
                <SelectTrigger id="sr-budget" className="w-full"><SelectValue placeholder={budgets.isPending ? "Loading…" : openBudgets.length ? "Pick the active budget" : "No active budget"} /></SelectTrigger>
                <SelectContent>
                  {openBudgets.map((b) => (
                    <SelectItem key={b.id} value={b.id}>{`${b.eventCode} · v${b.versionNo}${b.event?.name ? ` · ${b.event.name}` : ""}${b.status === "FROZEN" ? " (frozen)" : ""}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!budgets.isPending && openBudgets.length === 0 && <p className="text-xs text-muted-foreground">Only an active or frozen budget takes a request; none is open right now.</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="sr-line">Budget line</Label>
              <Select value={f.lineKey} onValueChange={(v) => set("lineKey", v)} disabled={!f.budgetId || budget.isPending}>
                <SelectTrigger id="sr-line" className="w-full"><SelectValue placeholder={!f.budgetId ? "Pick a budget first" : budget.isPending ? "Loading lines…" : "Pick the line"} /></SelectTrigger>
                <SelectContent>
                  {lines.map((l) => (
                    <SelectItem key={l.lineKey} value={l.lineKey}>{`${l.category.code} · ${l.description}${l.isContingency ? " (contingency)" : ""} · ${reporting} ${money2(l.remaining)} left`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedLine?.isContingency && <p className="text-xs text-muted-foreground">A draw from contingency is approved on the normal matrix like any other request.</p>}
            </div>
          </div>
        </section>

        <section className="space-y-3 rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">What is being bought</h2>
          <div className="space-y-1">
            <Label htmlFor="sr-title">Title</Label>
            <Input id="sr-title" value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="LED wall for the plenary hall" maxLength={200} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="sr-amount">Amount, ex-VAT</Label>
              <Input id="sr-amount" inputMode="decimal" value={f.amount} onChange={(e) => set("amount", e.target.value)} placeholder="0.00" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sr-tax">VAT amount</Label>
              <Input id="sr-tax" inputMode="decimal" value={f.taxAmount} onChange={(e) => set("taxAmount", e.target.value)} placeholder="0.00" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sr-currency">Currency</Label>
              <Select value={currency} onValueChange={(v) => set("currency", v)} disabled={!f.budgetId}>
                <SelectTrigger id="sr-currency" className="w-full"><SelectValue placeholder="Currency" /></SelectTrigger>
                <SelectContent>
                  {[...new Set([reporting, ...BUDGET_CURRENCIES, ...(f.currency ? [f.currency] : [])].filter(Boolean))].map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {!derived && (
            <div className="space-y-1 sm:w-1/3">
              <Label htmlFor="sr-rate">{`${currency} to ${reporting} rate`}</Label>
              <Input id="sr-rate" inputMode="decimal" value={f.fxRateToReporting} onChange={(e) => set("fxRateToReporting", e.target.value)} placeholder="1.0000" />
              <p className="text-xs text-muted-foreground">The budget check reads the amount in {reporting}; there is no fixed rate between these two.</p>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="sr-supplier">Supplier</Label>
              <Select value={f.supplierId || NONE} onValueChange={(v) => { set("supplierId", v === NONE ? "" : v); set("emailSupplierOnIssue", false); }}>
                <SelectTrigger id="sr-supplier" className="w-full"><SelectValue placeholder="Pick a supplier" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not on the list yet</SelectItem>
                  {(suppliers.data ?? []).map((s) => <SelectItem key={s.id} value={s.id}>{`${s.displayName}${s.approvalStatus !== "APPROVED" ? ` (${s.approvalStatus.toLowerCase()})` : ""}`}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {!f.supplierId && (
              <div className="space-y-1">
                <Label htmlFor="sr-vendor">Vendor you propose</Label>
                <Input id="sr-vendor" value={f.proposedVendorName} onChange={(e) => set("proposedVendorName", e.target.value)} placeholder="Gulf Audio Visual LLC" maxLength={200} />
                <p className="text-xs text-muted-foreground">Propose them on the Suppliers page too; an order waits until the supplier is approved.</p>
              </div>
            )}
          </div>
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch id="sr-email" checked={f.emailSupplierOnIssue && supplierHasEmail} onCheckedChange={(v) => set("emailSupplierOnIssue", v)} disabled={!supplierHasEmail} />
            <div className="space-y-0.5">
              <Label htmlFor="sr-email">Email the purchase order to the supplier when it is issued</Label>
              <p className="text-xs text-muted-foreground">
                {supplierHasEmail
                  ? "The PDF goes to the supplier's contact the moment the order is issued. Off, and someone sends it from the request page."
                  : f.supplierId
                    ? "This supplier has no contact email on the Suppliers page, so the order can only be sent by hand."
                    : "Pick a supplier from the list to email the order automatically; a proposed vendor has no address yet."}
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="sr-needed">Needed by</Label>
              <Input id="sr-needed" type="date" value={f.neededBy} onChange={(e) => set("neededBy", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sr-sourcing">Sourcing</Label>
              <Select value={f.sourcingMethod || NONE} onValueChange={(v) => set("sourcingMethod", v === NONE ? "" : (v as Sourcing))}>
                <SelectTrigger id="sr-sourcing" className="w-full"><SelectValue placeholder="How was it sourced?" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not stated</SelectItem>
                  {(Object.keys(SOURCING_LABEL) as Sourcing[]).map((k) => <SelectItem key={k} value={k}>{SOURCING_LABEL[k]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sr-priority">Priority</Label>
              <Select value={f.priority} onValueChange={(v) => set("priority", v as Priority)}>
                <SelectTrigger id="sr-priority" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{(Object.keys(PRIORITY_LABEL) as Priority[]).map((k) => <SelectItem key={k} value={k}>{PRIORITY_LABEL[k]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sr-why">Justification</Label>
            <Textarea id="sr-why" rows={3} value={f.justification} onChange={(e) => set("justification", e.target.value)} placeholder="Why this, why now, why this vendor. Required when the request goes over the line on a frozen budget." maxLength={4000} />
          </div>
        </section>

        <div className="flex flex-wrap justify-end gap-2">
          {onCancel && <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>}
          <Button onClick={() => void save()} disabled={!canSave || saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {request ? "Save changes" : "Save draft"}
          </Button>
        </div>
      </div>

      <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">Budget check</h2>
          {!f.budgetId || !f.lineKey ? (
            <p className="mt-2 text-sm text-muted-foreground">Pick a budget and a line to see what it has left.</p>
          ) : !query ? (
            <LinePanel reporting={reporting} line={selectedLine ?? null} />
          ) : preview.isPending ? (
            <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking…</div>
          ) : preview.isError ? (
            <p className="mt-2 text-sm text-destructive">{(preview.error as Error).message}</p>
          ) : preview.data ? (
            <PreviewPanel p={preview.data} />
          ) : null}
        </div>
        <p className="px-1 text-xs text-muted-foreground">Amounts are ex-VAT; the VAT is recorded beside them and never folded into a total. The check is run again when you submit.</p>
      </aside>
    </div>
  );
}

function LinePanel({ reporting, line }: { reporting: string; line: { description: string; planned: string; committedOpen: string; actual: string; remaining: string } | null }) {
  if (!line) return null;
  return (
    <dl className="mt-2 space-y-1 text-sm">
      <Row k="Line" v={line.description} />
      <Row k="Planned" v={`${reporting} ${money2(line.planned)}`} />
      <Row k="Committed" v={`${reporting} ${money2(line.committedOpen)}`} />
      <Row k="Actual" v={`${reporting} ${money2(line.actual)}`} />
      <Row k="Remaining" v={`${reporting} ${signed2(line.remaining)}`} strong />
      <p className="pt-1 text-xs text-muted-foreground">Enter an amount to see the check.</p>
    </dl>
  );
}

function PreviewPanel({ p }: { p: NonNullable<ReturnType<typeof useBudgetCheckPreview>["data"]> }) {
  const cur = p.budget.reportingCurrency;
  return (
    <div className="mt-2 space-y-3 text-sm">
      <dl className="space-y-1">
        <Row k="Line" v={p.line.description} />
        <Row k="Remaining now" v={`${cur} ${signed2(p.check.remainingBefore)}`} />
        <Row k="This request" v={`${cur} ${money2(p.check.amountReporting)}${p.rateSource === "same" ? "" : ` (at ${p.requestToReportingRate})`}`} />
        <Row k="Remaining after" v={`${cur} ${signed2(p.check.remainingAfter)}`} strong tone={Number(p.check.remainingAfter) < 0 ? "warn" : undefined} />
      </dl>
      <div className="flex items-center gap-2"><BudgetCheckBadge status={p.check.status} /></div>
      {p.check.exception && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{p.check.status === "FROZEN" ? "The budget is frozen and this goes over the line: it is routed to the final approver as an exception and needs your justification." : "This goes over the line: it is never allowed through quietly and is routed to the final approver as an exception."}</span>
        </div>
      )}
      <div className="rounded-md bg-muted/50 p-2 text-xs">
        {p.route.ok ? (
          <span>{`Goes to ${p.route.approverName ?? "the assigned approver"}${p.amountAed ? ` (AED ${money2(p.amountAed)} for the ceiling)` : ""}.`}</span>
        ) : p.route.code === "RATE_REQUIRED" ? (
          <span>{`${cur} floats against AED: the rate is asked for when you submit, and decides who approves.`}</span>
        ) : (
          <span className="flex items-start gap-1 text-destructive"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{p.route.message}</span>
        )}
      </div>
      {p.openRequests.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Already asked for on this line</div>
          {p.openRequests.map((o) => (
            <div key={o.id} className="flex justify-between gap-2 text-xs">
              <span className="truncate">{`${o.requestNo} · ${o.title}`}</span>
              <span className="shrink-0 tabular-nums">{o.amountReporting ? `${cur} ${money2(o.amountReporting)}` : ""}</span>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{"Not yet counted in the line's figures; they will be once their orders are raised."}</p>
        </div>
      )}
    </div>
  );
}

function Row({ k, v, strong, tone }: { k: string; v: string; strong?: boolean; tone?: "warn" }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={`text-right tabular-nums ${strong ? "font-semibold" : ""} ${tone === "warn" ? "text-destructive" : ""}`}>{v}</dd>
    </div>
  );
}
