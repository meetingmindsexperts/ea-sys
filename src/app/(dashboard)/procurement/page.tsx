"use client";

/**
 * /procurement, the budgets list: every event's budget versions with status,
 * planned, forecast and the at-risk flag, plus New budget (from a template).
 * Reads are for org staff; the New budget button is for budget authors
 * (ORGANIZER and above), the same predicate the POST asks.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { useEvents } from "@/hooks/use-api";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Inbox, Loader2, Plus, TriangleAlert, Wallet } from "lucide-react";

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "SAR"] as const;
const BRANDS: { value: string; label: string }[] = [
  { value: "MMG_EXPERTS", label: "MM Group Experts" },
  { value: "MEDCOM", label: "MedCom" },
  { value: "MEDULIVE", label: "MedULive" },
];

const EMPTY_FORM = { eventId: "", templateId: "", reportingCurrency: "AED", contingencyPercent: "10", expectedAttendance: "", brand: "" };

export default function ProcurementBudgetsPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const canAuthor = canAuthorBudgets(session?.user);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const { data: budgets = [], isLoading, isError, error } = useBudgets(statusFilter === "all" ? {} : { status: statusFilter });
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

  // Only an event with a code can hold a budget (the archive row and the
  // approval inbox are keyed on it); the dropdown says so rather than offering
  // events the POST would refuse.
  const codedEvents = useMemo(
    () => (events as { id: string; name: string; code: string | null; eventType: string; status: string }[]).filter((e) => !!e.code),
    [events],
  );
  const uncodedCount = (events as { code: string | null }[]).length - codedEvents.length;
  const eventById = useMemo(() => new Map(codedEvents.map((e) => [e.id, e])), [codedEvents]);

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

  async function submitCreate() {
    if (!form.eventId) {
      toast.error("Pick the event the budget is for.");
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
        templateId: form.templateId || null,
        reportingCurrency: form.reportingCurrency,
        contingencyPercent: Number(form.contingencyPercent || "10"),
        expectedAttendance: attendance,
        brand: form.brand || null,
      });
      toast.success(`Budget ${b.eventCode} v${b.versionNo} created as a draft.`);
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
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Wallet className="h-6 w-6 text-primary" />
            Budgets
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {`${budgets.length} budget version${budgets.length === 1 ? "" : "s"}${atRisk > 0 ? ` · ${atRisk} at risk` : ""}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/procurement/approvals">
              <Inbox className="h-4 w-4" />
              Approvals
              {inbox.length > 0 && <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-white">{inbox.length}</span>}
            </Link>
          </Button>
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
              <TableHead>Attendance</TableHead>
              <TableHead>Updated</TableHead>
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
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New budget</DialogTitle>
            <DialogDescription>
              A draft from a template: one blank line per category. Fill the lines, mark what does not apply, then submit for approval.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Event</Label>
              <Select value={form.eventId} onValueChange={pickEvent}>
                <SelectTrigger><SelectValue placeholder="Pick an event with a code" /></SelectTrigger>
                <SelectContent>
                  {codedEvents.map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.code} · {e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {uncodedCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {`${uncodedCount === 1 ? "One event has" : `${uncodedCount} events have`} no code yet and cannot hold a budget until one is set under the event's Settings.`}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Template</Label>
              <Select value={form.templateId || "none"} onValueChange={(v) => setForm((f) => ({ ...f, templateId: v === "none" ? "" : v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No template (start empty)</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name} · {t.lines.length} lines</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Reporting currency</Label>
                <Select value={form.reportingCurrency} onValueChange={(v) => setForm((f) => ({ ...f, reportingCurrency: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Locked once the budget has lines.</p>
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
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not set</SelectItem>
                    {BRANDS.map((b) => <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)} disabled={create.isPending}>Cancel</Button>
            <Button onClick={submitCreate} disabled={create.isPending}>
              {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Create draft
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
      <TableCell>
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
      <TableCell className="tabular-nums">{b.recordedAttendance ?? b.expectedAttendance ?? "–"}{b.recordedAttendance !== null && b.recordedAttendance !== undefined ? " recorded" : b.expectedAttendance !== null ? " expected" : ""}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{updated ? new Date(updated).toLocaleDateString("en-GB") : "draft"}</TableCell>
    </TableRow>
  );
}
