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

import { Fragment, useMemo, useState } from "react";
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

  const flaggedRows = new Set((plan?.warnings ?? []).filter((w) => w.kind !== "RESULT_ON_FOOTER" && w.kind !== "SUBTOTAL_MISMATCH").map((w) => w.rowNum));

  return (
    <div className="space-y-5 pb-4">
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
          Upload the costing sheet as CSV. Every total is recalculated from its lines; the sheet&apos;s own subtotals are only checked. Nothing is saved until
          you create the draft.
        </p>
      </div>

      <section className="space-y-4 rounded-lg border bg-card p-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="sheet-file">Budget sheet (CSV)</Label>
            {/* The native input is cleared after each read (so the same file can be read again), which would make it say
                "No file chosen" beside a loaded sheet; it stays for the label and keyboard, the button and name are what show. */}
            <input id="sheet-file" type="file" accept=".csv,text/csv" className="peer sr-only" disabled={productsLoading} onChange={(e) => void readFile(e.target)} />
            {/* The ring shows on the visible button while the hidden input has keyboard focus. */}
            <div className="flex min-w-0 items-center gap-3 rounded-md peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2">
              <Button asChild variant="outline" className={productsLoading ? "pointer-events-none opacity-50" : ""}>
                <label htmlFor="sheet-file" className="cursor-pointer"><FileSpreadsheet className="h-4 w-4" />{fileName ? "Choose another sheet" : "Choose a sheet"}</label>
              </Button>
              <span className="min-w-0 break-all text-sm text-muted-foreground">{fileName || "No sheet yet"}</span>
            </div>
            <p className="text-xs text-muted-foreground">In Excel: File, Save As, CSV. Semicolon or comma both work.</p>
          </div>
          <div className="space-y-2">
            <Label>Event</Label>
            <Select value={eventId} onValueChange={setEventId}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Pick an event with a code and no budget" /></SelectTrigger>
              <SelectContent>
                {eventOptions.map((e) => <SelectItem key={e.id} value={e.id}>{e.code} · {e.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">An event without a code gets one under its Settings first.</p>
          </div>
        </div>
        <div className="grid gap-4 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="contingency">Contingency %</Label>
            <Input id="contingency" type="number" min={0} max={100} step="0.5" value={contingency} onChange={(e) => setContingency(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="attendance">Expected attendance</Label>
            <Input id="attendance" type="number" min={0} value={attendance} onChange={(e) => setAttendance(e.target.value)} placeholder="Needed to submit" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="all-vat">VAT % for every line</Label>
            <div className="flex gap-2">
              <Input id="all-vat" type="number" min={0} max={100} step="0.5" value={allVat} onChange={(e) => setAllVat(e.target.value)} />
              <Button variant="outline" disabled={lines.length === 0} onClick={applyVatToAll}>Apply</Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="count-internal">Internal staff cost</Label>
            <div className="flex h-9 items-center gap-2.5">
              <Switch id="count-internal" checked={countInternal} onCheckedChange={setCountInternal} />
              <span className="text-sm text-muted-foreground">{countInternal ? "Counted as cost" : "Left at 0, as on the sheet"}</span>
            </div>
          </div>
        </div>
      </section>

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
            <Stat label="Contingency (AED)" value={money2(String((totals.cost * Number(contingency || 0)) / 100))} sub={`${contingency || 0}% of cost`} />
            <Stat label="Billed (AED)" value={withRevenue ? money2(String(totals.billed)) : "Finance only"} />
            <Stat
              label="Margin (AED)"
              value={withRevenue ? money2(String(totals.margin)) : "Finance only"}
              sub={withRevenue && totals.marginPercent !== null ? `${totals.marginPercent}% of billed` : undefined}
              tone={totals.margin < 0 ? "warn" : undefined}
            />
          </div>

          {plan.warnings.length > 0 && <SheetWarnings warnings={plan.warnings} />}

          <SheetLinesTable
            lines={lines}
            flaggedRows={flaggedRows}
            withRevenue={withRevenue}
            products={products}
            productsLoading={productsLoading}
            onPatch={patch}
          />

          {/* pr-24 keeps the button clear of the floating agent button, which sits fixed in this corner on every page. */}
          <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-3 rounded-lg border bg-background/95 py-3 pl-4 pr-24 shadow-sm backdrop-blur">
            <p className="mr-auto min-w-0 text-sm text-muted-foreground">
              {stop ?? (eventId ? "Ready: the draft opens when it is created." : "Pick the event the budget is for.")}
              {!withRevenue && " Billed amounts are left out: revenue needs finance access."}
            </p>
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

/** Grouped by kind, each group folded; the two that change the money picture start open. */
function SheetWarnings({ warnings }: { warnings: SheetWarning[] }) {
  const byKind = new Map<SheetWarning["kind"], SheetWarning[]>();
  for (const w of warnings) byKind.set(w.kind, [...(byKind.get(w.kind) ?? []), w]);
  const openFirst: ReadonlySet<SheetWarning["kind"]> = new Set(["RESULT_ON_FOOTER", "SUBTOTAL_MISMATCH"]);
  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-900 dark:bg-amber-950/40">
      <h2 className="flex items-center gap-2 font-medium text-amber-900 dark:text-amber-100">
        <TriangleAlert className="h-4 w-4 shrink-0" />
        {`${warnings.length} things to check on this sheet`}
      </h2>
      <div className="mt-3 grid items-start gap-2 lg:grid-cols-2">
        {WARNING_ORDER.filter((k) => byKind.has(k)).map((k) => (
          <details key={k} open={openFirst.has(k)} className="group rounded-md border border-amber-200 bg-background/70 px-3 py-2 dark:border-amber-900/60">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium">
              <span className="min-w-0">{WARNING_HEADING[k]}</span>
              <span className="shrink-0 rounded-full bg-amber-100 px-2 text-xs tabular-nums text-amber-900 dark:bg-amber-900 dark:text-amber-100">{byKind.get(k)!.length}</span>
            </summary>
            <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              {byKind.get(k)!.map((w) => <li key={`${w.rowNum}-${w.message}`}>{w.message}</li>)}
            </ul>
          </details>
        ))}
      </div>
    </section>
  );
}

type SectionGroup = { section: string; lines: EditableLine[] };

function bySection(lines: EditableLine[]): SectionGroup[] {
  const groups: SectionGroup[] = [];
  for (const l of lines) {
    const last = groups.at(-1);
    if (last && last.section === l.section) last.lines.push(l);
    else groups.push({ section: l.section, lines: [l] });
  }
  return groups;
}

function SheetLinesTable({ lines, flaggedRows, withRevenue, products, productsLoading, onPatch }: {
  lines: EditableLine[];
  flaggedRows: ReadonlySet<number>;
  withRevenue: boolean;
  products: Parameters<typeof ProductPicker>[0]["products"];
  productsLoading: boolean;
  onPatch: (rowNum: number, change: LineOverride) => void;
}) {
  const cols = withRevenue ? 7 : 6;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10" />
          <TableHead>Line</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Unit</TableHead>
          <TableHead className="text-right">Cost</TableHead>
          <TableHead className="w-20">VAT %</TableHead>
          {withRevenue && <TableHead className="text-right">Billed</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {bySection(lines).map((g) => {
          const t = planTotals(g.lines);
          return (
            <Fragment key={`${g.section}-${g.lines[0].rowNum}`}>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableCell colSpan={cols} className="whitespace-normal py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="font-semibold">{g.section || "Lines"}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {withRevenue ? `cost ${money2(String(t.cost))} · billed ${money2(String(t.billed))} · margin ${money2(String(t.margin))}` : `cost ${money2(String(t.cost))}`}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
              {g.lines.map((l) => (
                <SheetLineRow key={l.rowNum} line={l} flagged={flaggedRows.has(l.rowNum)} withRevenue={withRevenue} products={products} productsLoading={productsLoading} onPatch={(c) => onPatch(l.rowNum, c)} />
              ))}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
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
  const meta = [l.type === "INTERNAL" ? "Internal" : "", l.vendor, l.internalCostCounted ? "internal cost counted" : ""].filter(Boolean).join(" · ");
  const dim = l.include ? "" : "opacity-55";
  const showAccount = withRevenue && l.billedTotal > 0;
  return (
    <>
      <TableRow className={`border-b-0 hover:bg-transparent ${dim}`}>
        <TableCell className="pt-3 align-top">
          <Checkbox checked={l.include} onCheckedChange={(v) => onPatch({ include: v === true })} aria-label={`Include ${l.description}`} />
        </TableCell>
        {/* The shared cell never wraps; this one must, so a long line name stays inside its column. */}
        <TableCell className="min-w-[12rem] whitespace-normal pt-3 pb-1 align-top">
          <div className="flex items-start gap-1.5">
            {flagged && <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-label="See the warnings above" />}
            <div className="min-w-0">
              <div className="font-medium leading-snug">{l.ref ? <span className="mr-1.5 tabular-nums text-muted-foreground">{l.ref}</span> : null}{l.description}</div>
              {meta && <div className="mt-0.5 text-xs text-muted-foreground">{meta}</div>}
            </div>
          </div>
        </TableCell>
        <TableCell className="pt-3 text-right align-top tabular-nums">{l.isContingency ? "" : l.costQty}</TableCell>
        <TableCell className="pt-3 text-right align-top tabular-nums">{l.isContingency ? "" : money2(String(l.costUnit))}</TableCell>
        <TableCell className="pt-3 text-right align-top tabular-nums">{l.isContingency ? "–" : money2(String(l.costTotal))}</TableCell>
        <TableCell className="pt-2 align-top">
          <Input className="h-8 w-16" type="number" min={0} max={100} step="0.5" value={l.vatPercent} disabled={!needsExpenseLine(l)} onChange={(e) => onPatch({ vatPercent: e.target.value })} aria-label={`VAT for ${l.description}`} />
        </TableCell>
        {withRevenue && <TableCell className="pt-3 text-right align-top tabular-nums">{l.billedTotal > 0 ? money2(String(l.billedTotal)) : "–"}</TableCell>}
      </TableRow>
      {/* The pickers get a row of their own across the table, so they are never squeezed into the name column. */}
      <TableRow className={`hover:bg-transparent ${dim}`}>
        <TableCell />
        <TableCell colSpan={withRevenue ? 6 : 5} className="whitespace-normal pt-1 pb-3">
          <div className={`grid gap-2 ${showAccount ? "xl:grid-cols-2" : ""} max-w-4xl`}>
            {l.isContingency ? (
              <p className="text-sm text-muted-foreground">Sets the contingency percent; no cost line.</p>
            ) : (
              <ProductPicker
                products={products}
                loading={productsLoading}
                value={l.productId}
                onPick={(p) => onPatch(l.accountByHand || l.billedTotal <= 0 ? { productId: p.id, sku: p.sku } : { productId: p.id, sku: p.sku, incomeAccount: incomeAccountFor(p.sku, l.type, false) })}
                onClear={() => onPatch({ productId: null, sku: null })}
              />
            )}
            {showAccount && (
              <Select value={l.incomeAccount ?? ""} onValueChange={(v) => onPatch({ incomeAccount: v, accountByHand: true })}>
                <SelectTrigger className="h-9 w-full min-w-0" aria-label={`Income account for ${l.description}`}><SelectValue placeholder="Pick an income account" /></SelectTrigger>
                <SelectContent>
                  {INCOME_ACCOUNTS.map((a) => <SelectItem key={a.code} value={a.code}>{a.code} · {a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
        </TableCell>
      </TableRow>
    </>
  );
}
