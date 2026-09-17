"use client";

/**
 * The lines of one budget version, in one of three modes:
 *   plan     a DRAFT for an author: planned figures edit inline, lines are
 *            added and removed (the service refuses anything else);
 *   forecast an ACTIVE or FROZEN version for an author: the forecast
 *            override, its reason and the notes edit, the plan does not;
 *   read     everyone else, and every closed or archived version.
 * One row edits at a time, as a form row in the table's own width.
 */

import { useState } from "react";
import { toast } from "sonner";
import { BUDGET_CURRENCIES } from "@/procurement/lib/budget-schemas";
import { CONTINGENCY_CATEGORY_CODE } from "@/procurement/lib/budget-categories-seed";
import { useBudgetProducts, useDeleteBudgetLine, useUpsertBudgetLine, type BudgetCategoryRow, type BudgetLineRow, type BudgetRow } from "@/procurement/hooks/use-procurement-api";
import { ProductPicker } from "@/procurement/components/product-picker";
import { CategoryLabel, money2 } from "@/procurement/components/budget-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";

export type LinesMode = "plan" | "forecast" | "read";

export function sortLines(lines: BudgetLineRow[] | undefined): BudgetLineRow[] {
  return (lines ?? []).slice().sort((x, y) => (x.isContingency === y.isContingency ? x.sortOrder - y.sortOrder : x.isContingency ? 1 : -1));
}

/** The categories a line may sit on: active, expense, top level (the completeness check reads top level), never contingency. */
export function lineCategories(categories: BudgetCategoryRow[]): BudgetCategoryRow[] {
  return categories.filter((c) => c.isActive && c.type === "EXPENSE" && c.depth === 0 && c.code !== CONTINGENCY_CATEGORY_CODE).sort((a, b) => a.sortOrder - b.sortOrder);
}

export function BudgetLinesTable({ b, categories, mode }: { b: BudgetRow; categories: BudgetCategoryRow[]; mode: LinesMode }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<BudgetLineRow | null>(null);
  const remove = useDeleteBudgetLine(b.id);
  const lines = sortLines(b.lines);
  const cur = b.reportingCurrency;
  const planMode = mode === "plan";
  const cols = planMode ? 7 : mode === "forecast" ? 9 : 8;

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
    <div className="rounded-lg border bg-card">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead>Line</TableHead>
              {planMode ? (
                <>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit cost</TableHead>
                  <TableHead className="text-right">Tax</TableHead>
                </>
              ) : (
                <>
                  <TableHead className="text-right">Committed</TableHead>
                  <TableHead className="text-right">Actual</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Remaining</TableHead>
                </>
              )}
              <TableHead className="text-right">Planned</TableHead>
              {!planMode && <TableHead className="text-right">Forecast</TableHead>}
              {mode !== "read" && <TableHead className="w-24" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) =>
              editingId === l.id ? (
                <TableRow key={l.id}>
                  <TableCell colSpan={cols} className="bg-muted/30">
                    <LineEditForm b={b} categories={categories} mode={mode} line={l} onDone={() => setEditingId(null)} />
                  </TableCell>
                </TableRow>
              ) : (
                <LineRow key={l.id} l={l} cur={cur} mode={mode} onEdit={() => { setAdding(false); setEditingId(l.id); }} onDelete={() => setDeleting(l)} />
              ),
            )}
            {lines.length === 0 && !adding && (
              <TableRow><TableCell colSpan={cols} className="py-8 text-center text-muted-foreground">No lines yet.</TableCell></TableRow>
            )}
            {adding && (
              <TableRow>
                <TableCell colSpan={cols} className="bg-muted/30">
                  <LineEditForm b={b} categories={categories} mode="plan" onDone={() => setAdding(false)} />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {planMode && !adding && (
        <div className="border-t p-2">
          <Button variant="ghost" size="sm" onClick={() => { setEditingId(null); setAdding(true); }}>
            <Plus className="h-4 w-4" /> Add a line
          </Button>
        </div>
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this line?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting ? `"${deleting.description}" (${cur} ${money2(deleting.planned)}) leaves this draft. Its category may then need another line or the not-applicable mark before submission.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Keep</AlertDialogCancel>
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

function LineRow({ l, cur, mode, onEdit, onDelete }: { l: BudgetLineRow; cur: string; mode: LinesMode; onEdit: () => void; onDelete: () => void }) {
  const foreign = l.transactionCurrency !== cur;
  const remainingNeg = Number(l.remaining) < 0;
  const editable = mode !== "read" && !(mode === "plan" && l.isContingency);
  return (
    <TableRow className={l.isContingency ? "bg-muted/40" : undefined}>
      <TableCell className="text-xs text-muted-foreground"><CategoryLabel code={l.category.code} name={l.category.name} stacked /></TableCell>
      <TableCell>
        <div>
          {l.description}
          {l.product && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground" title={l.product.name}>{l.product.sku}</span>}
        </div>
        {foreign && <div className="text-xs text-muted-foreground">{`${l.transactionCurrency} ${money2(l.unitCost)} × ${Number(l.qty)} at ${Number(l.fxRateToReporting)}`}</div>}
        {l.forecastFinalAmount && <div className="text-xs text-amber-700 dark:text-amber-400">{`forecast override: ${l.forecastReason ?? ""}`}</div>}
        {l.varianceNote && <div className="text-xs text-muted-foreground">{`variance note: ${l.varianceNote}`}</div>}
        {l.notes && <div className="text-xs text-muted-foreground whitespace-pre-line">{l.notes}</div>}
      </TableCell>
      {mode === "plan" ? (
        <>
          <TableCell className="text-right tabular-nums">{l.isContingency ? "–" : Number(l.qty)}</TableCell>
          <TableCell className="text-right tabular-nums">{l.isContingency ? "–" : `${foreign ? `${l.transactionCurrency} ` : ""}${money2(l.unitCost)}`}</TableCell>
          <TableCell className="text-right tabular-nums">{l.taxRatePercent === null || l.isContingency ? "–" : `${Number(l.taxRatePercent)}%`}</TableCell>
        </>
      ) : (
        <>
          <TableCell className="text-right tabular-nums">{money2(l.committedTotal)}</TableCell>
          <TableCell className="text-right tabular-nums">{money2(l.actual)}</TableCell>
          <TableCell className="text-right tabular-nums">{money2(l.paid)}</TableCell>
          <TableCell className={`text-right tabular-nums ${remainingNeg ? "font-semibold text-red-600" : ""}`}>{money2(l.remaining)}</TableCell>
        </>
      )}
      <TableCell className="text-right tabular-nums">{money2(l.planned)}</TableCell>
      {mode !== "plan" && <TableCell className="text-right tabular-nums">{money2(l.forecast)}</TableCell>}
      {mode !== "read" && (
        <TableCell className="text-right">
          {editable && (
            <div className="flex justify-end gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit} aria-label={`Edit ${l.description}`}><Pencil className="h-4 w-4" /></Button>
              {mode === "plan" && (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={onDelete} aria-label={`Remove ${l.description}`}><Trash2 className="h-4 w-4" /></Button>
              )}
            </div>
          )}
        </TableCell>
      )}
    </TableRow>
  );
}

function LineEditForm({ b, categories, mode, line, onDone }: { b: BudgetRow; categories: BudgetCategoryRow[]; mode: LinesMode; line?: BudgetLineRow; onDone: () => void }) {
  const upsert = useUpsertBudgetLine(b.id);
  const cats = lineCategories(categories);
  const products = useBudgetProducts();
  const [f, setF] = useState(() => ({
    productId: line?.productId ?? "",
    categoryId: line?.categoryId ?? cats[0]?.id ?? "",
    description: line?.description ?? "",
    qty: line ? String(Number(line.qty)) : "1",
    unitCost: line ? String(Number(line.unitCost)) : "",
    transactionCurrency: line?.transactionCurrency ?? b.reportingCurrency,
    fxRateToReporting: line && line.transactionCurrency !== b.reportingCurrency ? String(Number(line.fxRateToReporting)) : "",
    taxRatePercent: line?.taxRatePercent === null || line?.taxRatePercent === undefined ? "" : String(Number(line.taxRatePercent)),
    forecastFinalAmount: line?.forecastFinalAmount ? String(Number(line.forecastFinalAmount)) : "",
    forecastReason: line?.forecastReason ?? "",
    notes: line?.notes ?? "",
  }));
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const foreign = f.transactionCurrency !== b.reportingCurrency;
  const currencies = BUDGET_CURRENCIES.includes(f.transactionCurrency as (typeof BUDGET_CURRENCIES)[number]) ? [...BUDGET_CURRENCIES] : [f.transactionCurrency, ...BUDGET_CURRENCIES];

  async function save() {
    try {
      if (mode === "plan") {
        if (!f.description.trim()) return toast.error("A line needs a description.");
        if (!f.categoryId) return toast.error("Pick a category.");
        if (foreign && !(Number(f.fxRateToReporting) > 0)) return toast.error(`A ${f.transactionCurrency} line needs its exchange rate to ${b.reportingCurrency}.`);
        await upsert.mutateAsync({
          lineId: line?.id,
          productId: f.productId || null,
          categoryId: f.categoryId,
          description: f.description.trim(),
          qty: f.qty.trim() === "" ? "1" : f.qty.trim(),
          unitCost: f.unitCost.trim() === "" ? "0" : f.unitCost.trim(),
          transactionCurrency: f.transactionCurrency,
          ...(foreign ? { fxRateToReporting: f.fxRateToReporting.trim() } : {}),
          taxRatePercent: f.taxRatePercent.trim() === "" ? null : f.taxRatePercent.trim(),
        });
        toast.success(line ? "Line saved." : "Line added.");
      } else {
        const override = f.forecastFinalAmount.trim();
        if (override !== "" && !f.forecastReason.trim()) return toast.error("A forecast override needs a reason (spec §6a).");
        await upsert.mutateAsync({
          lineId: line?.id,
          forecastFinalAmount: override === "" ? null : override,
          forecastReason: f.forecastReason.trim() || null,
          notes: f.notes.trim() || null,
        });
        toast.success("Line saved.");
      }
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="space-y-3 py-1">
      {mode === "plan" ? (
        <div className="grid gap-3 md:grid-cols-6">
          <div className="space-y-1 md:col-span-6">
            <Label className="text-xs">Catalogue item</Label>
            <ProductPicker
              products={products.data ?? []}
              loading={products.isPending}
              value={f.productId || null}
              onPick={(p) => setF((s) => ({ ...s, productId: p.id, description: p.name, categoryId: p.categoryId }))}
              onClear={() => set("productId", "")}
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label className="text-xs">Category</Label>
            {/* A catalogue item carries its account group, so the line follows it (the service refuses anything else). */}
            <Select value={f.categoryId} onValueChange={(v) => set("categoryId", v)} disabled={!!f.productId}>
              <SelectTrigger className="h-9" title={f.productId ? "Follows the catalogue item's account group. Clear the item to pick another category." : undefined}><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                {cats.map((c) => <SelectItem key={c.id} value={c.id}>{c.code} · {c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {f.productId && <p className="text-[11px] text-muted-foreground">Follows the catalogue item.</p>}
          </div>
          <div className="space-y-1 md:col-span-4">
            <Label className="text-xs">Description</Label>
            <Input className="h-9" value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="What the money is for" autoFocus />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Qty</Label>
            <Input className="h-9" type="number" min={0} step="any" value={f.qty} onChange={(e) => set("qty", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Unit cost (ex-VAT)</Label>
            <Input className="h-9" type="number" min={0} step="any" value={f.unitCost} onChange={(e) => set("unitCost", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Currency</Label>
            <Select value={f.transactionCurrency} onValueChange={(v) => set("transactionCurrency", v)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{currencies.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{`Rate to ${b.reportingCurrency}`}</Label>
            <Input className="h-9" type="number" min={0} step="any" value={foreign ? f.fxRateToReporting : "1"} disabled={!foreign} onChange={(e) => set("fxRateToReporting", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Tax %</Label>
            <Input className="h-9" type="number" min={0} step="any" value={f.taxRatePercent} onChange={(e) => set("taxRatePercent", e.target.value)} placeholder="none" />
          </div>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs">{`Forecast override (${b.reportingCurrency})`}</Label>
            <Input className="h-9" type="number" min={0} step="any" value={f.forecastFinalAmount} onChange={(e) => set("forecastFinalAmount", e.target.value)} placeholder={`default ${money2(line?.forecast)}`} />
          </div>
          <div className="space-y-1 md:col-span-3">
            <Label className="text-xs">Reason for the override</Label>
            <Input className="h-9" value={f.forecastReason} onChange={(e) => set("forecastReason", e.target.value)} placeholder="Why the final figure will differ from the plan" />
          </div>
          <div className="space-y-1 md:col-span-4">
            <Label className="text-xs">Notes</Label>
            <Textarea rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
          </div>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onDone} disabled={upsert.isPending}>Cancel</Button>
        <Button size="sm" onClick={() => void save()} disabled={upsert.isPending}>
          {upsert.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {line ? "Save line" : "Add line"}
        </Button>
      </div>
    </div>
  );
}
