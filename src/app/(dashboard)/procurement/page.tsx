"use client";

/**
 * /procurement, the budgets list: every event's budget versions with status,
 * planned, forecast and the at-risk flag, plus New budget (from a template)
 * and Import sheet (a draft from finance's costing sheet).
 * Reads are for org staff; the New budget button is for budget authors
 * (ORGANIZER and above), the same predicate the POST asks.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { useEvents } from "@/hooks/use-api";
import { useCan } from "@/hooks/use-can";
import { canAuthorBudgets } from "@/lib/procurement-visibility";
import Link from "next/link";
import {
  BUDGET_STATUS_LABEL,
  BUDGET_STATUS_ORDER,
  useApprovals,
  useBudgets,
  useBudgetTemplates,
  useCreateBudget,
  type BudgetRow,
  type BudgetStatus,
} from "@/procurement/hooks/use-procurement-api";
import { ErrorState, LoadingState, StatusBadge, money2 } from "@/procurement/components/budget-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { budgetableEvents, budgetEventLabel, uncodedRunningCount } from "@/procurement/lib/budget-events";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FileSpreadsheet, FileText, Inbox, Loader2, Plus, TriangleAlert, Wallet, Package, Truck } from "lucide-react";

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "SAR"] as const;
const BRANDS: { value: string; label: string }[] = [
  { value: "MMG_EXPERTS", label: "MM Group Experts" },
  { value: "MEDCOM", label: "MedCom" },
  { value: "MEDULIVE", label: "MedULive" },
];

const EMPTY_FORM = { eventId: "", startFrom: "template" as StartFrom, templateId: "", fromBudgetId: "", priceChange: "0", reportingCurrency: "AED", contingencyPercent: "10", expectedAttendance: "", brand: "" };

/**
 * Where a new budget's lines come from: a template's blank lines, a past budget's plan (owner, Oct 28, 2026),
 * or a costing sheet, which hands over to the Import sheet page with the event picked (owner, Nov 4, 2026).
 */
type StartFrom = "template" | "copy" | "sheet";
const START_FROM: readonly [StartFrom, string][] = [["template", "Template"], ["copy", "Past budget"], ["sheet", "CSV sheet"]];

/** Short enough to sit in the field without being cut; the event's name is shown under it instead. */
function sourceLabel(b: BudgetRow): string {
  return `${b.eventCode} v${b.versionNo} · ${BUDGET_STATUS_LABEL[b.status]} · ${b.reportingCurrency} ${money2(b.plannedExpenseTotal)}`;
}

export default function ProcurementBudgetsPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const canAuthor = canAuthorBudgets(session?.user);
  const canSeeRevenue = useCan("finance.view") === "allowed";
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const { data: budgets = [], isLoading, isError, error } = useBudgets(statusFilter === "all" ? {} : { status: statusFilter });
  // Unfiltered: the copy source list and the "already has a budget" test must not follow the status filter.
  const { data: allBudgets = [] } = useBudgets();
  const { data: events = [] } = useEvents();
  const { data: templates = [] } = useBudgetTemplates();
  const { data: inbox = [] } = useApprovals("inbox");
  const create = useCreateBudget();

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [prevOpen, setPrevOpen] = useState(false);
  if (creating !== prevOpen) {
    setPrevOpen(creating);
    if (creating) setForm(EMPTY_FORM);
  }

  const typedEvents = events as { id: string; name: string; code: string | null; eventType: string; status: string }[];
  const eventById = useMemo(() => new Map(typedEvents.map((e) => [e.id, e])), [typedEvents]);
  // Coded, running (published or live) and without a budget yet: the rule lives in budget-events.ts.
  const budgetedEventIds = useMemo(() => new Set(allBudgets.map((b) => b.eventId)), [allBudgets]);
  const openEvents = useMemo(() => budgetableEvents(typedEvents, budgetedEventIds), [typedEvents, budgetedEventIds]);
  const eventOptions = useMemo(() => openEvents.map((e) => ({ value: e.id, label: budgetEventLabel(e) })), [openEvents]);
  const uncodedCount = useMemo(() => uncodedRunningCount(typedEvents, budgetedEventIds), [typedEvents, budgetedEventIds]);
  const pickedEvent = form.eventId ? eventById.get(form.eventId) : undefined;
  const copySources = useMemo(() => [...allBudgets].sort((a, b) => a.eventCode.localeCompare(b.eventCode) || b.versionNo - a.versionNo), [allBudgets]);
  const source = form.startFrom === "copy" ? allBudgets.find((b) => b.id === form.fromBudgetId) : undefined;

  const counts = useMemo(() => {
    const c: Partial<Record<BudgetStatus, number>> = {};
    for (const b of budgets) c[b.status] = (c[b.status] ?? 0) + 1;
    return c;
  }, [budgets]);
  const atRisk = budgets.filter((b) => b.atRisk && (b.status === "ACTIVE" || b.status === "FROZEN")).length;

  function pickEvent(eventId: string) {
    const ev = eventById.get(eventId);
    // The template follows the event type by default; the organiser can still change it.
    const match = ev ? templates.find((t) => t.eventType === ev.eventType) : undefined;
    setForm((f) => ({ ...f, eventId, templateId: match?.id ?? f.templateId }));
  }

  function pickSource(budgetId: string) {
    const b = allBudgets.find((x) => x.id === budgetId);
    // A copy keeps its source's currency (the service refuses another) and starts from its contingency.
    setForm((f) => ({ ...f, fromBudgetId: budgetId, reportingCurrency: b?.reportingCurrency ?? f.reportingCurrency, contingencyPercent: b ? String(Number(b.contingencyPercent)) : f.contingencyPercent }));
  }

  async function submitCreate() {
    if (!form.eventId) {
      toast.error("Pick the event the budget is for.");
      return;
    }
    if (form.startFrom === "sheet") {
      router.push(`/procurement/budgets/import?eventId=${encodeURIComponent(form.eventId)}`);
      return;
    }
    if (form.startFrom === "copy" && !form.fromBudgetId) {
      toast.error("Pick the budget to copy from.");
      return;
    }
    const priceChange = Number(form.priceChange || "0");
    if (form.startFrom === "copy" && !(priceChange >= -50 && priceChange <= 100)) {
      toast.error("The price change must be between -50% and +100%.");
      return;
    }
    const attendance = form.expectedAttendance.trim() === "" ? null : Number(form.expectedAttendance);
    if (attendance !== null && (!Number.isInteger(attendance) || attendance < 0)) {
      toast.error("Expected attendance must be a whole number.");
      return;
    }
    try {
      const b = await create.mutateAsync({
        eventId: form.eventId,
        templateId: form.startFrom === "template" ? form.templateId || null : null,
        fromBudgetId: form.startFrom === "copy" ? form.fromBudgetId : null,
        priceChangePercent: form.startFrom === "copy" ? priceChange : null,
        reportingCurrency: form.reportingCurrency,
        contingencyPercent: Number(form.contingencyPercent || "10"),
        expectedAttendance: attendance,
        brand: form.brand || null,
      });
      toast.success(form.startFrom === "copy" ? `Budget ${b.eventCode} v${b.versionNo} created as a draft, copied from ${source?.eventCode ?? "the past budget"}.` : `Budget ${b.eventCode} v${b.versionNo} created as a draft.`);
      setCreating(false);
      router.push(`/procurement/budgets/${b.id}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (isLoading) return <LoadingState label="Loading budgets…" />;
  if (isError) return <ErrorState title="Couldn't load the budgets" message={(error as Error)?.message ?? "The module may not be switched on for this deployment."} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Wallet className="h-6 w-6 shrink-0 text-primary" />
            Budgets
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {`${budgets.length} budget version${budgets.length === 1 ? "" : "s"}${atRisk > 0 ? ` · ${atRisk} at risk` : ""}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/procurement/requests">
              <FileText className="h-4 w-4" />
              Requests
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/procurement/suppliers">
              <Truck className="h-4 w-4" />
              Suppliers
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/procurement/products">
              <Package className="h-4 w-4" />
              Products
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/procurement/approvals">
              <Inbox className="h-4 w-4" />
              Approvals
              {inbox.length > 0 && <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-white">{inbox.length}</span>}
            </Link>
          </Button>
          {canAuthor && (
            <Button asChild variant="outline">
              <Link href="/procurement/budgets/import">
                <FileSpreadsheet className="h-4 w-4" />
                Import sheet
              </Link>
            </Button>
          )}
          {canAuthor && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              New budget
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {BUDGET_STATUS_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(statusFilter === s ? "all" : s)}
            className={`rounded-lg border p-3 text-left transition hover:bg-muted/60 ${statusFilter === s ? "border-primary bg-muted/60" : "bg-card"}`}
          >
            <div className="text-xs text-muted-foreground">{BUDGET_STATUS_LABEL[s]}</div>
            <div className="text-2xl font-semibold tabular-nums">{counts[s] ?? 0}</div>
          </button>
        ))}
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Planned</TableHead>
              <TableHead className="text-right">Contingency</TableHead>
              <TableHead className="text-right">Forecast</TableHead>
              {/* The two least-used columns wait for a wide screen, so the table fits beside the sidebar at 1024px. */}
              <TableHead className="hidden xl:table-cell">Attendance</TableHead>
              <TableHead className="hidden xl:table-cell">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {budgets.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  {statusFilter === "all" ? "No budgets yet." : `No ${BUDGET_STATUS_LABEL[statusFilter as BudgetStatus].toLowerCase()} budgets.`}
                </TableCell>
              </TableRow>
            )}
            {budgets.map((b) => (
              <BudgetListRow key={b.id} b={b} eventName={b.eventId ? eventById.get(b.eventId)?.name : undefined} />
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>New budget</DialogTitle>
            <DialogDescription>
              A draft for one event: blank lines from a template, a copy of a past budget&apos;s plan, or a costing sheet. Adjust it, then submit for approval.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="budget-event">Event</Label>
              <SearchableSelect
                id="budget-event"
                value={form.eventId}
                displayLabel={pickedEvent ? budgetEventLabel(pickedEvent) : undefined}
                onChange={pickEvent}
                options={eventOptions}
                placeholder="Pick an event"
                searchPlaceholder="Search by code or name"
                emptyText="No published or live event without a budget."
              />
              <p className="text-xs text-muted-foreground">
                Published and live events only.
                {uncodedCount > 0 && ` ${uncodedCount === 1 ? "One more has" : `${uncodedCount} more have`} no code yet; set one under the event's Settings.`}
              </p>
            </div>
            <div className="space-y-2">
              <Label>Start from</Label>
              <Tabs value={form.startFrom} onValueChange={(v) => setForm((f) => ({ ...f, startFrom: v as StartFrom }))}>
                <TabsList aria-label="Start from" className="grid w-full grid-cols-3">
                  {START_FROM.map(([value, text]) => <TabsTrigger key={value} value={value}>{text}</TabsTrigger>)}
                </TabsList>
                {/* Each option's fields are its tab's panel, so every trigger points at a panel that exists. */}
                <TabsContent value="sheet" className="pt-2">
                  <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                    Continue to upload the costing sheet (in Excel: File, Save As, CSV). You check every line, its category and product, and set the contingency and attendance there before the draft is created.
                  </p>
                </TabsContent>
                <TabsContent value="template" className="pt-2">
                  <div className="space-y-2">
                    <Label>Template</Label>
                    <Select value={form.templateId || "none"} onValueChange={(v) => setForm((f) => ({ ...f, templateId: v === "none" ? "" : v }))}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No template (start empty)</SelectItem>
                        {templates.map((t) => (
                          <SelectItem key={t.id} value={t.id}>{t.name} · {t.lines.length} lines</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </TabsContent>
                <TabsContent value="copy" className="pt-2">
                  <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
                    <div className="min-w-0 space-y-2">
                      <Label>Budget to copy</Label>
                      <Select value={form.fromBudgetId} onValueChange={pickSource}>
                        <SelectTrigger className="w-full min-w-0"><SelectValue placeholder="Pick a past budget" /></SelectTrigger>
                        <SelectContent>
                          {copySources.map((b) => (
                            <SelectItem key={b.id} value={b.id}>{sourceLabel(b)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="price-change">Price change %</Label>
                      <Input id="price-change" type="number" min={-50} max={100} step="0.5" value={form.priceChange} onChange={(e) => setForm((f) => ({ ...f, priceChange: e.target.value }))} />
                    </div>
                    <p className="text-xs text-muted-foreground sm:col-span-2">
                      {copyHint(source, source?.eventId ? eventById.get(source.eventId)?.name : undefined, form.priceChange, canSeeRevenue)}
                    </p>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
            {form.startFrom !== "sheet" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Reporting currency</Label>
                  <Select value={form.reportingCurrency} onValueChange={(v) => setForm((f) => ({ ...f, reportingCurrency: v }))} disabled={form.startFrom === "copy"}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{form.startFrom === "copy" ? "A copy keeps its source's currency." : "Locked once the budget has lines."}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contingency">Contingency %</Label>
                  <Input id="contingency" type="number" min={0} max={100} step="0.5" value={form.contingencyPercent} onChange={(e) => setForm((f) => ({ ...f, contingencyPercent: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="attendance">Expected attendance</Label>
                  <Input id="attendance" type="number" min={0} value={form.expectedAttendance} onChange={(e) => setForm((f) => ({ ...f, expectedAttendance: e.target.value }))} placeholder="Required to submit" />
                </div>
                <div className="space-y-2">
                  <Label>Brand</Label>
                  <Select value={form.brand || "none"} onValueChange={(v) => setForm((f) => ({ ...f, brand: v === "none" ? "" : v }))}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not set</SelectItem>
                      {BRANDS.map((b) => <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)} disabled={create.isPending}>Cancel</Button>
            <Button onClick={submitCreate} disabled={create.isPending}>
              {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {form.startFrom === "sheet" ? "Continue to the sheet" : "Create draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BudgetListRow({ b, eventName }: { b: BudgetRow; eventName?: string }) {
  const router = useRouter();
  const updated = b.closedAt ?? b.frozenAt ?? b.activatedAt ?? b.approvedAt ?? b.submittedAt;
  return (
    <TableRow className="cursor-pointer" onClick={() => router.push(`/procurement/budgets/${b.id}`)}>
      <TableCell className="min-w-[12rem] whitespace-normal">
        <div className="font-medium">{b.eventCode}</div>
        {eventName && <div className="text-xs text-muted-foreground">{eventName}</div>}
      </TableCell>
      <TableCell className="tabular-nums">v{b.versionNo}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <StatusBadge status={b.status} />
          {b.atRisk && (b.status === "ACTIVE" || b.status === "FROZEN") && (
            <span title="The forecast exceeds planned plus contingency" className="text-amber-600"><TriangleAlert className="h-4 w-4" /></span>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">{b.reportingCurrency} {money2(b.plannedExpenseTotal)}</TableCell>
      <TableCell className="text-right tabular-nums">{money2(b.contingencyAmount)} <span className="text-xs text-muted-foreground">({Number(b.contingencyPercent)}%)</span></TableCell>
      <TableCell className="text-right tabular-nums">{money2(b.forecastTotal)}</TableCell>
      <TableCell className="hidden tabular-nums xl:table-cell">{b.recordedAttendance ?? b.expectedAttendance ?? "–"}{attendanceSuffix(b.recordedAttendance, b.expectedAttendance)}</TableCell>
      <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">{updated ? new Date(updated).toLocaleDateString("en-GB") : "draft"}</TableCell>
    </TableRow>
  );
}

/** The dialog's line under the copy fields: what will travel, and roughly how much. */
function copyHint(source: BudgetRow | undefined, eventName: string | undefined, priceChange: string, canSeeRevenue: boolean): string {
  if (!source) return "Only the plan is copied: lines, quantities and unit prices, with the price change applied to every unit price.";
  const what = canSeeRevenue ? "planned lines and revenue lines" : "planned lines";
  const where = eventName ? ` (${eventName})` : "";
  const revenueNote = canSeeRevenue ? "" : " Revenue lines need finance access and are not copied.";
  return `Copies the ${what} of ${source.eventCode} v${source.versionNo}${where}, about ${copyTotal(source.plannedExpenseTotal, priceChange)} ${source.reportingCurrency} planned. Commitments, actuals and forecasts stay with that event.${revenueNote}`;
}

/** The copy's planned total after the price change, for the dialog's one-line preview. */
function copyTotal(planned: string, priceChange: string): string {
  const pct = Number(priceChange || "0");
  return money2(String(Number(planned) * (1 + (Number.isFinite(pct) ? pct : 0) / 100)));
}

function attendanceSuffix(recorded: number | null | undefined, expected: number | null | undefined): string {
  if (recorded !== null && recorded !== undefined) return " recorded";
  return expected !== null ? " expected" : "";
}
