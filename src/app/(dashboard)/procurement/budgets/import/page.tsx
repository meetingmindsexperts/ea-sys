"use client";

/**
 * /procurement/budgets/import: a draft budget from finance's costing sheet
 * (budget-sheet-import.ts). The sheet is read here, in the browser, by the
 * pure reader; nothing is stored until Create draft, which posts the checked
 * lines to the ordinary create route, so the draft is made in one transaction
 * and goes through approval like any other.
 *
 * What the person sees before creating: every total recomputed from the lines
 * (never the sheet's subtotals), every warning the reader raised, and per line
 * the suggested catalogue product, the VAT rate and the income account, each
 * of which they may change. Billed amounts become revenue lines only for
 * someone with finance sight, the same rule as the budget page.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { useEvents } from "@/hooks/use-api";
import { useCan } from "@/hooks/use-can";
import { canAuthorBudgets } from "@/lib/procurement-visibility";
import { useBudgetProducts, useBudgets, useCreateBudget } from "@/procurement/hooks/use-procurement-api";
import {
  incomeAccountFor,
  parseBudgetSheet,
  planBudgetSheet,
  planTotals,
  type ParsedSheet,
  type PlannedSheetLine,
  type SheetPlan,
  type SheetWarning,
} from "@/procurement/lib/budget-sheet-import";
import { INCOME_ACCOUNTS } from "@/procurement/lib/income-accounts";
import { ErrorState, Stat, money2 } from "@/procurement/components/budget-ui";
import { ProductPicker } from "@/procurement/components/product-picker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, FileSpreadsheet, Loader2, TriangleAlert } from "lucide-react";

const MAX_FILE_BYTES = 1024 * 1024;

/** A line on the preview: the reader's plan plus what the person set. */
interface EditableLine extends PlannedSheetLine {
  vatPercent: string;
  accountByHand?: boolean;
}

/** What the person changed on a line, kept apart from the plan so a re-plan never loses it. */
type LineOverride = Partial<Pick<EditableLine, "include" | "productId" | "sku" | "incomeAccount" | "vatPercent">> & {
  /** The income account was picked by hand, so a later product pick leaves it alone. */
  accountByHand?: boolean;
};

const WARNING_HEADING: Record<SheetWarning["kind"], string> = {
  RESULT_ON_FOOTER: "What the sheet says it earned",
  SUBTOTAL_MISMATCH: "Sheet totals that leave lines out",
  UNBILLED_COST: "Costs billed to nobody",
  BILLED_WITHOUT_COST: "Billed with no cost recorded",
  NEGATIVE_AMOUNT: "Credits and discounts (left out)",
  NO_GRAND_TOTAL: "No grand total on the sheet",
  BILLED_BELOW_COST: "Billed below cost",
  INTERNAL_COST_ZERO: "Internal cost the sheet set to zero",
  QTY_MISMATCH: "Cost and billing quantities differ",
  QUOTED_NOT_ORDERED: "Quoted but quantity 0 (left out)",
  UNIT_TOTAL_MISMATCH: "Unit × quantity is not the total",
  UNMAPPED: "No catalogue product",
  DUPLICATE_REF: "Line numbers used twice",
  MISSING_REF: "Lines with no number",
  MISSING_TYPE: "Lines with no type",
};
const WARNING_ORDER = Object.keys(WARNING_HEADING) as SheetWarning["kind"][];

const fixed = (n: number, dp = 2) => (Math.round(n * 10 ** dp) / 10 ** dp).toString();

function toEditable(plan: SheetPlan | null, overrides: ReadonlyMap<number, LineOverride>): EditableLine[] {
  return (plan?.lines ?? []).map((l) => ({ ...l, vatPercent: "0", ...(overrides.get(l.rowNum) ?? {}) }));
}

/** Why the draft cannot be created yet, or null. */
function blocker(lines: EditableLine[], withRevenue: boolean): string | null {
  const included = lines.filter((l) => l.include);
  if (included.length === 0) return "No lines are ticked.";
  const negative = included.find((l) => l.costTotal < 0 || l.billedTotal < 0);
  if (negative) return `${negative.ref || "Row " + negative.rowNum} ${negative.description} is negative; a budget line cannot be. Untick it.`;
  const noProduct = included.find((l) => !l.isContingency && needsExpenseLine(l) && !l.productId);
  if (noProduct) return `Pick a catalogue product for ${noProduct.ref || "row " + noProduct.rowNum} ${noProduct.description}.`;
  const noAccount = withRevenue ? included.find((l) => l.billedTotal > 0 && !l.incomeAccount) : undefined;
  if (noAccount) return `Pick an income account for ${noAccount.ref || "row " + noAccount.rowNum} ${noAccount.description}.`;
  const badVat = included.find((l) => !(Number(l.vatPercent) >= 0 && Number(l.vatPercent) <= 100));
  if (badVat) return `The VAT rate on ${badVat.description} must be between 0 and 100.`;
  return null;
}

/** An expense line is created for a cost, or for a ticked quote with neither cost nor billing (a placeholder). */
function needsExpenseLine(l: EditableLine): boolean {
  if (l.isContingency) return false;
  return l.costTotal > 0 || l.billedTotal === 0;
}

export default function ImportBudgetSheetPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const canAuthor = canAuthorBudgets(session?.user);
  const withRevenue = useCan("finance.view") === "allowed";
  const { data: events = [] } = useEvents();
  const { data: budgets = [] } = useBudgets();
  const { data: products = [], isLoading: productsLoading } = useBudgetProducts();
  const create = useCreateBudget();

  const [fileName, setFileName] = useState("");
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [overrides, setOverrides] = useState<ReadonlyMap<number, LineOverride>>(new Map());
  const [countInternal, setCountInternal] = useState(true);
  const [eventId, setEventId] = useState("");
  const [contingency, setContingency] = useState("10");
  const [attendance, setAttendance] = useState("");
  const [allVat, setAllVat] = useState("0");

  // An event can hold one budget family: offer only coded events with none yet.
  const withBudget = useMemo(() => new Set(budgets.map((b) => b.eventId)), [budgets]);
  const eventOptions = useMemo(
    () => (events as { id: string; name: string; code: string | null }[]).filter((e) => !!e.code && !withBudget.has(e.id)),
    [events, withBudget],
  );
  const catalogue = useMemo(() => products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, isActive: p.isActive })), [products]);
  // Derived, never stored: a catalogue that arrives after the file, or the
  // internal-cost switch, re-plans the sheet without losing what was changed.
  const plan = useMemo(
    () => (sheet && sheet.lines.length > 0 ? planBudgetSheet(sheet, { products: catalogue, countInternalCost: countInternal }) : null),
    [sheet, catalogue, countInternal],
  );
  const lines = useMemo(() => toEditable(plan, overrides), [plan, overrides]);
  const totals = useMemo(() => planTotals(lines), [lines]);
  const vatTotal = useMemo(() => lines.filter((l) => l.include && needsExpenseLine(l)).reduce((s, l) => s + (l.costTotal * Number(l.vatPercent || 0)) / 100, 0), [lines]);
  const stop = blocker(lines, withRevenue);

  async function readFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    // Cleared so choosing the same file again (after fixing it in Excel) reads it again.
    input.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.error("The file is over 1 MB. A budget sheet is far smaller; check it is the right file.");
      return;
    }
    const parsed = parseBudgetSheet(await file.text());
    setFileName(file.name);
    setSheet(parsed);
    setOverrides(new Map());
    if (parsed.errors.length > 0 && parsed.lines.length === 0) {
      toast.error(parsed.errors[0].message);
      return;
    }
    const pct = parsed.lines.find((l) => l.contingencyPercent !== null)?.contingencyPercent ?? null;
    setContingency(pct === null ? "10" : String(pct));
  }

  const patch = (rowNum: number, change: LineOverride) =>
    setOverrides((prev) => new Map(prev).set(rowNum, { ...(prev.get(rowNum) ?? {}), ...change }));
  const applyVatToAll = () =>
    setOverrides((prev) => new Map(lines.map((l) => [l.rowNum, { ...(prev.get(l.rowNum) ?? {}), vatPercent: allVat || "0" }])));

  async function submit() {
    if (!plan || stop) return;
    if (!eventId) {
      toast.error("Pick the event the budget is for.");
      return;
    }
    const expected = attendance.trim() === "" ? null : Number(attendance);
    if (expected !== null && (!Number.isInteger(expected) || expected < 0)) {
      toast.error("Expected attendance must be a whole number.");
      return;
    }
    const included = lines.filter((l) => l.include);
    // The sheet's income and result are finance figures; the budget notes are read without finance sight.
    const result = withRevenue ? plan.warnings.filter((w) => w.kind === "RESULT_ON_FOOTER").map((w) => w.message) : [];
    try {
      const b = await create.mutateAsync({
        eventId,
        reportingCurrency: "AED",
        contingencyPercent: Number(contingency || "0"),
        expectedAttendance: expected,
        importedFrom: fileName.slice(0, 200),
        notes: [`Imported from the budget sheet "${fileName}"${plan.title ? ` (${plan.title})` : ""}. Amounts ex-VAT as entered on the sheet; billed amounts are revenue lines.`, ...result].join("\n").slice(0, 5000),
        lines: included.filter(needsExpenseLine).map((l) => ({
          productId: l.productId!,
          description: l.description,
          qty: fixed(l.costQty, 4),
          unitCost: fixed(l.costUnit, 4),
          taxRatePercent: Number(l.vatPercent) > 0 ? l.vatPercent : null,
          notes: l.notes || null,
        })),
        revenueLines: withRevenue
          ? included.filter((l) => l.billedTotal > 0).map((l) => ({
              incomeAccount: l.incomeAccount!,
              description: l.description,
              qty: fixed(l.billedQty, 4),
              unitAmount: fixed(l.billedUnit, 4),
              notes: `Billed per sheet ${l.ref || "row " + l.rowNum}`,
            }))
          : [],
      });
      toast.success(`Budget ${b.eventCode} v${b.versionNo} created as a draft from the sheet.`);
      router.push(`/procurement/budgets/${b.id}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (!canAuthor) return <ErrorState title="Budget authors only" message="Importing a budget sheet creates a budget, which needs budget author access." backHref="/procurement" backLabel="Back to budgets" />;

  const warningsByKind = new Map<SheetWarning["kind"], SheetWarning[]>();
  for (const w of plan?.warnings ?? []) warningsByKind.set(w.kind, [...(warningsByKind.get(w.kind) ?? []), w]);
  const flaggedRows = new Set((plan?.warnings ?? []).filter((w) => w.kind !== "RESULT_ON_FOOTER" && w.kind !== "SUBTOTAL_MISMATCH").map((w) => w.rowNum));

  return (
    <div className="space-y-5">
      <div>
        <Link href="/procurement" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Budgets
        </Link>
        <h1 className="mt-2 flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
          <FileSpreadsheet className="h-6 w-6 shrink-0 text-primary" />
          Import budget sheet
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Upload the costing sheet (CSV, comma or semicolon) with the ACT COST and PER UNIT columns. Every total is recalculated from the lines, and the
          sheet&apos;s own subtotals are only checked against them. Nothing is saved until you create the draft.
        </p>
      </div>

      <div className="grid gap-4 rounded-lg border bg-card p-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="sheet-file">Budget sheet</Label>
          <Input id="sheet-file" type="file" accept=".csv,text/csv" disabled={productsLoading} onChange={(e) => void readFile(e.target)} />
          <p className="text-xs text-muted-foreground">{fileName || "In Excel: File, Save As, CSV."}</p>
        </div>
        <div className="space-y-2">
          <Label>Event</Label>
          <Select value={eventId} onValueChange={setEventId}>
            <SelectTrigger><SelectValue placeholder="An event with a code and no budget" /></SelectTrigger>
            <SelectContent>
              {eventOptions.map((e) => <SelectItem key={e.id} value={e.id}>{e.code} · {e.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">An event without a code gets one under its Settings first.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="contingency">Contingency %</Label>
            <Input id="contingency" type="number" min={0} max={100} step="0.5" value={contingency} onChange={(e) => setContingency(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="attendance">Attendance</Label>
            <Input id="attendance" type="number" min={0} value={attendance} onChange={(e) => setAttendance(e.target.value)} placeholder="Expected" />
          </div>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="count-internal" className="leading-snug">Count internal staff cost</Label>
            <Switch id="count-internal" checked={countInternal} onCheckedChange={setCountInternal} />
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-2">
              <Label htmlFor="all-vat">VAT % for every line</Label>
              <Input id="all-vat" type="number" min={0} max={100} step="0.5" value={allVat} onChange={(e) => setAllVat(e.target.value)} />
            </div>
            <Button variant="outline" disabled={lines.length === 0} onClick={applyVatToAll}>Apply</Button>
          </div>
        </div>
      </div>

      {sheet && sheet.errors.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          {sheet.errors.map((e) => <p key={`${e.rowNum}-${e.message}`}>{e.message}</p>)}
        </div>
      )}

      {plan && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Cost (AED, ex-VAT)" value={money2(String(totals.cost))} sub={`${lines.filter((l) => l.include).length} of ${lines.length} lines ticked`} />
            <Stat label="VAT (AED)" value={money2(String(vatTotal))} sub={`incl. VAT ${money2(String(totals.cost + vatTotal))}`} />
            <Stat label="Contingency" value={money2(String((totals.cost * Number(contingency || 0)) / 100))} sub={`${contingency || 0}% of cost`} />
            <Stat label="Billed (AED)" value={withRevenue ? money2(String(totals.billed)) : "Needs finance access"} />
            <Stat
              label="Margin"
              value={withRevenue ? money2(String(totals.margin)) : "–"}
              sub={withRevenue && totals.marginPercent !== null ? `${totals.marginPercent}% of billed` : undefined}
              tone={totals.margin < 0 ? "warn" : undefined}
            />
          </div>

          {plan.warnings.length > 0 && (
            <details open className="rounded-lg border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-900 dark:bg-amber-950/40">
              <summary className="flex cursor-pointer items-center gap-2 font-medium text-amber-900 dark:text-amber-100">
                <TriangleAlert className="h-4 w-4" />
                {`${plan.warnings.length} things to check on this sheet`}
              </summary>
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                {WARNING_ORDER.filter((k) => warningsByKind.has(k)).map((k) => (
                  <div key={k}>
                    <div className="text-sm font-semibold">{`${WARNING_HEADING[k]} (${warningsByKind.get(k)!.length})`}</div>
                    <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                      {warningsByKind.get(k)!.map((w) => <li key={`${w.rowNum}-${w.message}`}>{w.message}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          )}

          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Line</TableHead>
                  <TableHead className="min-w-56">Catalogue product</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="w-20">VAT %</TableHead>
                  {withRevenue && <TableHead className="text-right">Billed</TableHead>}
                  {withRevenue && <TableHead className="min-w-48">Income account</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l) => (
                  <SheetLineRow
                    key={l.rowNum}
                    line={l}
                    flagged={flaggedRows.has(l.rowNum)}
                    withRevenue={withRevenue}
                    products={products}
                    productsLoading={productsLoading}
                    onPatch={(change) => patch(l.rowNum, change)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {stop && <p className="text-sm text-amber-800 dark:text-amber-300">{stop}</p>}
            {!withRevenue && <p className="text-sm text-muted-foreground">Billed amounts are left out: revenue needs finance access.</p>}
            <Button onClick={submit} disabled={!!stop || !eventId || create.isPending}>
              {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Create draft budget
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function SheetLineRow({ line: l, flagged, withRevenue, products, productsLoading, onPatch }: {
  line: EditableLine;
  flagged: boolean;
  withRevenue: boolean;
  products: Parameters<typeof ProductPicker>[0]["products"];
  productsLoading: boolean;
  onPatch: (change: LineOverride) => void;
}) {
  const muted = l.include ? "" : "opacity-50";
  const costLabel = l.isContingency ? "sets %" : money2(String(l.costTotal));
  return (
    <TableRow className={muted}>
      <TableCell>
        <Checkbox checked={l.include} onCheckedChange={(v) => onPatch({ include: v === true })} aria-label={`Include ${l.description}`} />
      </TableCell>
      <TableCell className="max-w-72">
        <div className="flex items-start gap-1.5">
          {flagged && <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-label="See the warnings above" />}
          <div>
            <div className="font-medium">{l.ref ? `${l.ref} ` : ""}{l.description}</div>
            <div className="text-xs text-muted-foreground">{[l.section, l.type === "INTERNAL" ? "Internal" : "", l.vendor, l.internalCostCounted ? "internal cost counted" : ""].filter(Boolean).join(" · ")}</div>
          </div>
        </div>
      </TableCell>
      <TableCell>
        {l.isContingency ? (
          <span className="text-sm text-muted-foreground">Contingency line</span>
        ) : (
          <ProductPicker
            products={products}
            loading={productsLoading}
            value={l.productId}
            onPick={(p) => onPatch(l.accountByHand || l.billedTotal <= 0 ? { productId: p.id, sku: p.sku } : { productId: p.id, sku: p.sku, incomeAccount: incomeAccountFor(p.sku, l.type, false) })}
            onClear={() => onPatch({ productId: null, sku: null })}
          />
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{l.isContingency ? "" : l.costQty}</TableCell>
      <TableCell className="text-right tabular-nums">{l.isContingency ? "" : money2(String(l.costUnit))}</TableCell>
      <TableCell className="text-right tabular-nums">{costLabel}</TableCell>
      <TableCell>
        <Input className="h-8 w-16" type="number" min={0} max={100} step="0.5" value={l.vatPercent} disabled={!needsExpenseLine(l)} onChange={(e) => onPatch({ vatPercent: e.target.value })} aria-label={`VAT for ${l.description}`} />
      </TableCell>
      {withRevenue && <TableCell className="text-right tabular-nums">{l.billedTotal > 0 ? money2(String(l.billedTotal)) : "–"}</TableCell>}
      {withRevenue && (
        <TableCell>
          {l.billedTotal > 0 && (
            <Select value={l.incomeAccount ?? ""} onValueChange={(v) => onPatch({ incomeAccount: v, accountByHand: true })}>
              <SelectTrigger className="h-8"><SelectValue placeholder="Pick an account" /></SelectTrigger>
              <SelectContent>
                {INCOME_ACCOUNTS.map((a) => <SelectItem key={a.code} value={a.code}>{a.code} · {a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </TableCell>
      )}
    </TableRow>
  );
}
