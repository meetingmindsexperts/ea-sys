"use client";

/**
 * The revenue side of a budget version (spec §6b; owner decisions of 17
 * September 2026). Planned revenue is typed per income account on a draft;
 * actual revenue is read, never typed, from paid registrations and won CRM
 * deals linked to the event, split by the deal's products. What cannot be put
 * under an account is shown as its own row rather than guessed: a won deal's
 * value not covered by products, products whose In-House/Out-Sourced and
 * category pair has no income account, and amounts in a currency without a
 * fixed rate. Margin is revenue against expense, both without VAT.
 *
 * Rendered only for a reader with finance sight (the route refuses the rest).
 */

import { useState } from "react";
import { toast } from "sonner";
import { BUDGET_CURRENCIES } from "@/procurement/lib/budget-schemas";
import {
  useBudgetRevenue,
  useDeleteRevenueLine,
  useUpsertRevenueLine,
  type BudgetRevenue,
  type BudgetRow,
  type RevenueLineRow,
} from "@/procurement/hooks/use-procurement-api";
import { CategoryLabel, Stat, money2 } from "@/procurement/components/budget-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Loader2, Pencil, Plus, Trash2, TrendingUp, TriangleAlert } from "lucide-react";

const SOURCE_LABEL: Record<string, string> = { IN_HOUSE: "In-House", OUTSOURCED: "Out-Sourced" };

function percent(v: string | null): string | null {
  return v === null ? null : `${Number(v).toFixed(1)}%`;
}

export function BudgetRevenueSection({ b, editable }: { b: BudgetRow; editable: boolean }) {
  const { data, isLoading, isError, error } = useBudgetRevenue(b.id);
  const cur = b.reportingCurrency;

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold"><TrendingUp className="h-4 w-4 text-primary" /> Revenue and margin</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {`Planned revenue is typed per income account. Actual revenue is read from paid registrations and won CRM deals linked to this event. All figures without VAT, in ${cur}.`}
        </p>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Reading registrations and deals…</div>
      ) : isError || !data ? (
        <p className="py-4 text-sm text-destructive">{`Couldn't load the revenue: ${(error as Error)?.message ?? "unknown error"}`}</p>
      ) : (
        <RevenueBody b={b} data={data} editable={editable} />
      )}
    </section>
  );
}

function RevenueBody({ b, data, editable }: { b: BudgetRow; data: BudgetRevenue; editable: boolean }) {
  const cur = data.reportingCurrency;
  const m = data.margin;
  const a = data.actuals;
  const target = percent(data.targetMarginPercent);
  const notItemised = Number(a.notItemised);
  const noAccount = Number(a.noAccount.amount);
  const plannedSum = data.accounts.reduce((s, r) => s + Number(r.planned), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Planned revenue" value={`${cur} ${money2(m.plannedRevenue)}`} sub={`${data.lines.length} planned line${data.lines.length === 1 ? "" : "s"}`} />
        <Stat label="Actual revenue" value={`${cur} ${money2(a.total)}`} sub={`${a.paidRegistrations} paid registration${a.paidRegistrations === 1 ? "" : "s"} · ${a.wonDeals} won deal${a.wonDeals === 1 ? "" : "s"}`} />
        <Stat label="Planned margin" value={`${cur} ${money2(m.plannedMargin)}`} sub={m.plannedMarginPercent !== null ? `${percent(m.plannedMarginPercent)} of planned revenue` : "no planned revenue"} />
        <Stat
          label="Forecast margin"
          value={`${cur} ${money2(m.forecastMargin)}`}
          tone={m.belowTarget ? "warn" : undefined}
          sub={[m.forecastMarginPercent !== null ? `${percent(m.forecastMarginPercent)} of revenue` : null, target ? `target ${target}` : "no target set"].filter(Boolean).join(" · ")}
        />
      </div>
      {m.belowTarget && (
        <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {`The forecast margin is below the ${target} target. Forecast revenue takes the larger of plan and actual per account; forecast cost is the expense forecast.`}
        </p>
      )}

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Income account</TableHead>
              <TableHead className="text-right">Planned</TableHead>
              <TableHead className="text-right">Actual</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.accounts.length === 0 && notItemised === 0 && noAccount === 0 ? (
              <TableRow><TableCell colSpan={3} className="py-6 text-center text-sm text-muted-foreground">No planned revenue and nothing received yet.</TableCell></TableRow>
            ) : (
              data.accounts.map((r) => (
                <TableRow key={r.code}>
                  <TableCell className="text-sm"><CategoryLabel code={r.code} name={r.name} /></TableCell>
                  <TableCell className="text-right tabular-nums">{money2(r.planned)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money2(r.actual)}</TableCell>
                </TableRow>
              ))
            )}
            {notItemised !== 0 && (
              <TableRow className="bg-muted/30">
                <TableCell className="text-sm">
                  Not itemised on won deals
                  <div className="text-xs text-muted-foreground">{notItemised > 0 ? "Deal values not covered by the deals' products." : "The deals' products add up to more than the deal values."}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">–</TableCell>
                <TableCell className="text-right tabular-nums">{money2(a.notItemised)}</TableCell>
              </TableRow>
            )}
            {noAccount !== 0 && (
              <TableRow className="bg-muted/30">
                <TableCell className="text-sm">
                  Products with no income account
                  <ul className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
                    {a.noAccount.products.map((p, i) => (
                      <li key={`${p.productName}-${i}`}>{`${p.productName} (${p.source ? SOURCE_LABEL[p.source] : "source unknown"}, ${p.category ?? "no category"}): ${money2(p.amount)}`}</li>
                    ))}
                  </ul>
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">–</TableCell>
                <TableCell className="text-right tabular-nums">{money2(a.noAccount.amount)}</TableCell>
              </TableRow>
            )}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-medium">Total</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{money2(String(plannedSum))}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{money2(a.total)}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      {a.notConverted.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {`Not counted, because there is no fixed rate to ${cur}: `}
          {a.notConverted.map((n) => `${n.currency} ${money2(n.amount)} from ${n.from}`).join("; ")}.
        </p>
      )}

      <RevenueLines b={b} data={data} editable={editable} />
    </div>
  );
}

function RevenueLines({ b, data, editable }: { b: BudgetRow; data: BudgetRevenue; editable: boolean }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<RevenueLineRow | null>(null);
  const remove = useDeleteRevenueLine(b.id);
  const cur = data.reportingCurrency;
  if (!editable && data.lines.length === 0) return null;

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success(`"${deleting.description}" removed.`);
      setDeleting(null);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Planned revenue lines</div>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Income account</TableHead>
              <TableHead>Line</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Unit amount</TableHead>
              <TableHead className="text-right">{`Planned (${cur})`}</TableHead>
              {editable && <TableHead className="w-20" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.lines.map((l) =>
              editingId === l.id ? (
                <TableRow key={l.id}>
                  <TableCell colSpan={editable ? 6 : 5} className="bg-muted/30">
                    <RevenueLineForm b={b} data={data} line={l} onDone={() => setEditingId(null)} />
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow key={l.id}>
                  <TableCell className="text-xs text-muted-foreground"><CategoryLabel code={l.category.code} name={l.category.name} stacked /></TableCell>
                  <TableCell>
                    {l.description}
                    {l.transactionCurrency !== cur && <div className="text-xs text-muted-foreground">{`${l.transactionCurrency} ${money2(l.unitAmount)} × ${Number(l.qty)} at ${Number(l.fxRateToReporting)}`}</div>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.qty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{`${l.transactionCurrency} ${money2(l.unitAmount)}`}</TableCell>
                  <TableCell className="text-right tabular-nums">{money2(l.planned)}</TableCell>
                  {editable && (
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${l.description}`} onClick={() => { setAdding(false); setEditingId(l.id); }}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Remove ${l.description}`} onClick={() => setDeleting(l)}><Trash2 className="h-4 w-4" /></Button>
                    </TableCell>
                  )}
                </TableRow>
              ),
            )}
            {data.lines.length === 0 && !adding && (
              <TableRow><TableCell colSpan={editable ? 6 : 5} className="py-6 text-center text-sm text-muted-foreground">No planned revenue yet. Add a line for each income account the event expects, such as delegate sales or sponsorship.</TableCell></TableRow>
            )}
            {adding && (
              <TableRow>
                <TableCell colSpan={6} className="bg-muted/30">
                  <RevenueLineForm b={b} data={data} onDone={() => setAdding(false)} />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {editable && !adding && (
        <Button variant="outline" size="sm" onClick={() => { setEditingId(null); setAdding(true); }}><Plus className="h-4 w-4" /> Add a revenue line</Button>
      )}
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && !remove.isPending && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this revenue line?</AlertDialogTitle>
            <AlertDialogDescription>{deleting ? `"${deleting.description}" leaves the planned revenue.` : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={(e) => { e.preventDefault(); void confirmDelete(); }} disabled={remove.isPending}>
              {remove.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RevenueLineForm({ b, data, line, onDone }: { b: BudgetRow; data: BudgetRevenue; line?: RevenueLineRow; onDone: () => void }) {
  const upsert = useUpsertRevenueLine(b.id);
  const accounts = data.categories.filter((c) => c.isActive || c.id === line?.categoryId);
  const cur = data.reportingCurrency;
  const [f, setF] = useState(() => ({
    categoryId: line?.categoryId ?? "",
    description: line?.description ?? "",
    qty: line ? String(Number(line.qty)) : "1",
    unitAmount: line ? String(Number(line.unitAmount)) : "",
    transactionCurrency: line?.transactionCurrency ?? cur,
    fxRateToReporting: line && line.transactionCurrency !== cur ? String(Number(line.fxRateToReporting)) : "",
  }));
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const foreign = f.transactionCurrency !== cur;

  async function save() {
    if (!f.categoryId) return toast.error("Pick the income account.");
    if (!f.description.trim()) return toast.error("A revenue line needs a description.");
    if (foreign && !(Number(f.fxRateToReporting) > 0)) return toast.error(`A ${f.transactionCurrency} line needs its exchange rate to ${cur}.`);
    try {
      await upsert.mutateAsync({
        lineId: line?.id,
        categoryId: f.categoryId,
        description: f.description.trim(),
        qty: f.qty.trim() === "" ? "1" : f.qty.trim(),
        unitAmount: f.unitAmount.trim() === "" ? "0" : f.unitAmount.trim(),
        transactionCurrency: f.transactionCurrency,
        ...(foreign ? { fxRateToReporting: f.fxRateToReporting.trim() } : {}),
      });
      toast.success(line ? "Revenue line saved." : "Revenue line added.");
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="space-y-3 py-1">
      <div className="grid gap-3 md:grid-cols-6">
        <div className="space-y-1 md:col-span-3">
          <Label className="text-xs">Income account</Label>
          <Select value={f.categoryId} onValueChange={(v) => set("categoryId", v)}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Pick an income account" /></SelectTrigger>
            <SelectContent>{accounts.map((c) => <SelectItem key={c.id} value={c.id}>{`${c.code} · ${c.name}`}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1 md:col-span-3">
          <Label className="text-xs">Description</Label>
          <Input className="h-9" value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Early bird physicians, Gold sponsorship, ..." />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Qty</Label>
          <Input className="h-9" type="number" min={0} step="any" value={f.qty} onChange={(e) => set("qty", e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Unit amount (ex-VAT)</Label>
          <Input className="h-9" type="number" min={0} step="any" value={f.unitAmount} onChange={(e) => set("unitAmount", e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Currency</Label>
          <Select value={f.transactionCurrency} onValueChange={(v) => set("transactionCurrency", v)}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>{BUDGET_CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{`Rate to ${cur}`}</Label>
          <Input className="h-9" type="number" min={0} step="any" value={foreign ? f.fxRateToReporting : "1"} disabled={!foreign} onChange={(e) => set("fxRateToReporting", e.target.value)} />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onDone} disabled={upsert.isPending}>Cancel</Button>
        <Button size="sm" onClick={() => void save()} disabled={upsert.isPending}>{upsert.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {line ? "Save line" : "Add line"}</Button>
      </div>
    </div>
  );
}
